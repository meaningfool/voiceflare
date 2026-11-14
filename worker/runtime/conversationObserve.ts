import { enterConversationNode, hasCompleteNodeTranscriptInventory } from "./conversationNode.ts";
import { requireConversationState } from "./conversationContracts.ts";
import type { RuntimeImplementation } from "./implementationContracts.ts";
import { observeConversationUsage } from "./conversationUsage.ts";
import type { ConversationSemanticEvidence } from "./interviewFinalizationModel.ts";
import type { RuntimeToolCallOutcome, RuntimeToolCallDescription } from "./toolCallRecord.ts";
import {
  admittedFinalInputItemId,
  completedReasonOf,
  drainCheckpointAt,
  getSerializedTranscriptTurns,
  isFinishingNode,
  nodeLimitation,
  updateNodeDispatch,
  type GracefulCompletionState,
  type SerializedTranscriptCapture,
  type SerializedTranscriptItem,
  type FinalizationLiveState,
  type FinalizationDrainingState,
  type FinalizationClosingProviderState,
  type FinalizationFinalizingState,
  type FinalizationEndedState,
  type InterviewFinalizationState,
  type FinalizationEffectStatus,
  type FinalizationEffectRecord,
  type FinalInputWarning,
  type FinalInputState,
  type TranscriptObligation,
  type ProviderObservationOrder,
  type ProviderResponseLifecycle,
  type OrderedProviderFinalizationObservation,
  type ProviderFinalizationObservation,
  type FinalizationObservation,
  type RuntimeTranscriptIncompleteReason,
  type InterviewFinalizationAggregate,
  type FinalizationDecision,
} from "./interviewFinalizationModel.ts";
import {
  addEffect,
  observationAt,
  replaceFinalizationStateEffects,
  addWarning,
} from "./interviewFinalizationComposition.ts";
import { type ResultWarning } from "../shared/runtimeControllerCallback.ts";

export function recoverInterruptedEffects(
  aggregate: InterviewFinalizationAggregate,
): FinalizationDecision {
  const interruptedProviderHangup = aggregate.state.effects.some(
    (effect) => effect.status === "sending" && effect.kind === "release_session",
  );
  let changed = false;
  const effects = aggregate.state.effects.map((effect) => {
    if (effect.status !== "sending") return effect;
    changed = true;
    const status: FinalizationEffectStatus =
      effect.kind === "compute_transcript_digest" || effect.kind === "arm_alarm"
        ? "pending"
        : "uncertain";
    return { ...effect, status, attemptCount: effect.attemptCount + 1 };
  });
  let state: InterviewFinalizationState = changed
    ? replaceFinalizationStateEffects(aggregate.state, effects)
    : aggregate.state;
  if (
    interruptedProviderHangup &&
    state.stage !== "live" &&
    state.stage !== "ended" &&
    !state.sessionClosed &&
    !state.warnings.includes("session_release_uncertain")
  ) {
    changed = true;
    state = { ...state, warnings: addWarning([...state.warnings], "session_release_uncertain") };
  }
  return {
    aggregate: changed ? { ...aggregate, state } : aggregate,
    effects: [],
    events: [],
  };
}

export function observeProviderResponseEvidence(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservation,
): InterviewFinalizationAggregate {
  let responses = aggregate.providerResponses;
  let unidentifiedOutputAudioActive = aggregate.unidentifiedOutputAudioActive;

  switch (observation.kind) {
    case "reply_started":
      responses = upsertProviderResponse(responses, observation.responseId, {
        status: "active",
      });
      break;
    case "reply_generated": {
      const status = observation.status ?? "completed";
      const nonTranscriptInventory =
        observation.status === "completed" &&
        observation.transcriptInventoryComplete === true &&
        observation.transcriptItems !== undefined &&
        observation.transcriptItems.length > 0 &&
        observation.transcriptItems.every((item) => item.nonTranscript === true);
      responses = upsertProviderResponse(
        responses,
        observation.responseId,
        nonTranscriptInventory ? { status, nonTranscriptInventoryComplete: true } : { status },
      );
      break;
    }
    case "reply_cancelled":
      responses = upsertProviderResponse(responses, observation.responseId, {
        status: "cancelled",
      });
      break;
    case "provider_finish_interview_observed":
      responses = upsertProviderResponse(responses, observation.responseId, {
        status: observation.responseStatus ?? "active",
      });
      break;
    case "provider_finish_interview_rejected":
      if (observation.responseId !== undefined && observation.responseStatus !== undefined) {
        responses = upsertProviderResponse(responses, observation.responseId, {
          status: observation.responseStatus,
        });
      }
      break;
    case "reply_delivery_started": {
      const responseId =
        observation.responseId ?? uniqueProviderAudioCandidateResponseId(responses);
      if (responseId === null) {
        unidentifiedOutputAudioActive = true;
      } else {
        responses = upsertProviderResponse(responses, responseId, {
          outputAudio: "active",
          status: "active",
        });
      }
      break;
    }
    case "reply_delivery_stopped": {
      const responseId =
        observation.responseId ?? uniqueProviderAudioCandidateResponseId(responses);
      if (responseId === null) {
        unidentifiedOutputAudioActive = false;
      } else {
        const stopped: Parameters<typeof upsertProviderResponse>[2] = {
          outputAudio: "stopped",
          status: "active",
        };
        responses = upsertProviderResponse(
          responses,
          responseId,
          observation.playbackEndsAt === undefined
            ? stopped
            : { ...stopped, playbackEndsAt: observation.playbackEndsAt },
        );
      }
      break;
    }
    default:
      break;
  }

  let gracefulCompletion = aggregate.gracefulCompletion;
  if (
    gracefulCompletion !== null &&
    !(
      observation.kind === "provider_finish_interview_observed" &&
      observation.responseId !== gracefulCompletion.responseId
    )
  ) {
    const admittedResponseId = gracefulCompletion.responseId;
    const admitted = responses.find((response) => response.responseId === admittedResponseId);
    if (admitted !== undefined) {
      const responseSettlement =
        admitted.status === "active" || admitted.status === "unobserved"
          ? gracefulCompletion.responseSettlement
          : admitted.status;
      // A participant safety override keeps the selected output contained.
      gracefulCompletion = gracefulCompletion.participantMediaSafetyOverride
        ? { ...gracefulCompletion, responseSettlement }
        : {
            ...gracefulCompletion,
            responseSettlement,
            outputAudioSettlement: admitted.outputAudio,
          };
    }
  }

  if (
    responses === aggregate.providerResponses &&
    unidentifiedOutputAudioActive === aggregate.unidentifiedOutputAudioActive &&
    gracefulCompletion === aggregate.gracefulCompletion
  ) {
    return aggregate;
  }
  return {
    ...aggregate,
    providerResponses: responses,
    unidentifiedOutputAudioActive,
    gracefulCompletion,
  };
}

export function upsertProviderResponse(
  responses: readonly ProviderResponseLifecycle[],
  responseId: string,
  patch: Readonly<{
    status?: ProviderResponseLifecycle["status"];
    outputAudio?: ProviderResponseLifecycle["outputAudio"];
    nonTranscriptInventoryComplete?: true;
    conversationScope?: ProviderResponseLifecycle["conversationScope"];
    playbackEndsAt?: number;
  }>,
): readonly ProviderResponseLifecycle[] {
  const index = responses.findIndex((response) => response.responseId === responseId);
  const current = responses[index];
  const status =
    current === undefined
      ? (patch.status ?? "active")
      : current.status !== "active" && current.status !== "unobserved" && patch.status === "active"
        ? current.status
        : (patch.status ?? current.status);
  const outputAudio = patch.outputAudio ?? current?.outputAudio ?? "pending";
  const inventory =
    patch.nonTranscriptInventoryComplete === true
      ? { nonTranscriptInventoryComplete: true as const }
      : {};
  const scope =
    patch.conversationScope !== undefined && current?.conversationScope === undefined
      ? { conversationScope: structuredClone(patch.conversationScope) }
      : {};
  const playback =
    patch.playbackEndsAt === undefined ? {} : { playbackEndsAt: patch.playbackEndsAt };
  let next: ProviderResponseLifecycle;
  if (status === "active" || status === "unobserved") {
    // An open response has not proven its inventory.
    const { nonTranscriptInventoryComplete: _inventory, ...open } = {
      nonTranscriptInventoryComplete: undefined,
      ...(current ?? { responseId }),
    };
    next = { ...open, status, outputAudio, ...scope, ...playback };
  } else
    next = {
      ...(current ?? { responseId }),
      status,
      outputAudio,
      ...inventory,
      ...scope,
      ...playback,
    };
  if (current === undefined) return [...responses, next];
  if (JSON.stringify(next) === JSON.stringify(current)) return responses;
  const updated = [...responses];
  updated[index] = next;
  return updated;
}

export function uniqueProviderAudioCandidateResponseId(
  responses: readonly ProviderResponseLifecycle[],
): string | null {
  const candidates = responses.filter(
    (response) =>
      response.outputAudio === "active" ||
      (response.outputAudio === "pending" &&
        (response.status === "active" || response.status === "completed")),
  );
  return candidates.length === 1 ? (candidates[0]?.responseId ?? null) : null;
}

export function observeProvider(
  state: InterviewFinalizationState,
  admittedInputItemId: string | null,
  observation: Exclude<
    FinalizationObservation,
    {
      kind:
        | "end_requested"
        | "effect_outcome"
        | "interrupted_effects_recovered"
        | "transcript_digest_computed"
        | "deadline_reached";
    }
  >,
): InterviewFinalizationState {
  if (state.stage === "ended" || state.stage === "finalizing") return state;
  const effectAcceptanceState = observeProviderEffectAcceptance(state, observation);
  if (effectAcceptanceState !== state) return effectAcceptanceState;
  if (state.stage === "live") return observeLiveProvider(state, observation);
  return observeEndingProvider(state, admittedInputItemId, observation);
}

export function observeProviderEffectAcceptance(
  state: InterviewFinalizationState,
  observation: Exclude<
    FinalizationObservation,
    {
      kind:
        | "end_requested"
        | "effect_outcome"
        | "interrupted_effects_recovered"
        | "transcript_digest_computed"
        | "deadline_reached";
    }
  >,
): InterviewFinalizationState {
  // An input closure that found nothing to settle, or a cancel that found its reply already
  // finished, was carried out; any other step the provider refused failed.
  const effects =
    observation.kind === "nothing_to_settle" || observation.kind === "nothing_to_cancel"
      ? state.effects.map((effect) =>
          effect.id === observation.commandId &&
          effect.kind ===
            (observation.kind === "nothing_to_settle" ? "close_input" : "cancel_reply")
            ? { ...effect, status: "dispatched" as const, acceptance: "benign_rejection" as const }
            : effect,
        )
      : observation.kind === "session_error_observed" && observation.eventId !== undefined
        ? state.effects.map((effect) =>
            effect.id === observation.eventId
              ? { ...effect, status: "failed" as const, acceptance: "rejected" as const }
              : effect,
          )
        : state.effects;
  return effects.every((effect, index) => effect === state.effects[index])
    ? state
    : replaceFinalizationStateEffects(state, effects);
}

export function settleObservedProviderEffectConsequences(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservation,
): InterviewFinalizationAggregate {
  const state = aggregate.state;
  if (state.stage === "ended") return aggregate;
  const terminalResponseId =
    observation.kind === "reply_generated" || observation.kind === "reply_cancelled"
      ? observation.responseId
      : null;
  const outputStopped = observation.kind === "reply_delivery_stopped";
  const allOutputStopped =
    outputStopped &&
    !aggregate.unidentifiedOutputAudioActive &&
    aggregate.providerResponses.every((response) => response.outputAudio !== "active");
  const effects = state.effects.map((effect): FinalizationEffectRecord => {
    const consequenceObserved =
      (effect.kind === "cancel_reply" && effect.responseId === terminalResponseId) ||
      (effect.kind === "stop_output" && allOutputStopped);
    if (
      !consequenceObserved ||
      (effect.status !== "uncertain" &&
        effect.status !== "failed" &&
        effect.acceptance !== "rejected")
    ) {
      return effect;
    }
    return { ...effect, status: "dispatched", acceptance: "benign_rejection" };
  });
  return effects.every((effect, index) => effect === state.effects[index])
    ? aggregate
    : { ...aggregate, state: replaceFinalizationStateEffects(state, effects) };
}

export function observeFinalInput(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservation,
  stateBeforeObservation: InterviewFinalizationState,
): InterviewFinalizationAggregate {
  const finalInput = aggregate.finalInput;
  const state = aggregate.state;
  if (finalInput === null || state.stage === "finalizing" || state.stage === "ended") {
    return aggregate;
  }
  if (state.stage !== "live" && state.stage !== "draining" && state.stage !== "closing_provider")
    return aggregate;
  const endingState = state;

  if (observation.kind === "participant_answer_created") {
    if (observation.itemId === finalInput.admittedItemId) {
      return {
        ...aggregate,
        state: {
          ...state,
          activeInputItemId: activeInputItemIdForState(stateBeforeObservation),
        },
        finalInput: {
          ...finalInput,
          duplicateCount: finalInput.duplicateCount + 1,
        },
      };
    }

    if (
      finalInput.obligation === "awaiting_item" &&
      isBeyondFinalInputFence(finalInput, observation)
    ) {
      return {
        ...aggregate,
        finalInput: {
          ...finalInput,
          obligation: "awaiting_transcription",
          admittedItemId: observation.itemId,
          settledByTerminalObservation: false,
          quietDeadline: observationAt(observation) + 1_000,
        },
        state: { ...endingState, activeInputItemId: observation.itemId },
      };
    }

    const warning = isBeyondFinalInputFence(finalInput, observation)
      ? "post_end_input_leaked"
      : "ambiguous_final_activity";
    return withFinalInputWarning(
      {
        ...aggregate,
        state: {
          ...endingState,
          activeInputItemId: activeInputItemIdForState(stateBeforeObservation),
        },
      },
      warning,
    );
  }

  if (
    observation.kind === "participant_answer_transcribed" &&
    observation.itemId === finalInput.admittedItemId
  ) {
    return {
      ...aggregate,
      finalInput: {
        ...finalInput,
        obligation: "settled",
        settledByTerminalObservation: true,
        quietDeadline: observationAt(observation) + 1_000,
      },
    };
  }

  if (
    observation.kind === "participant_answer_transcription_failed" &&
    observation.itemId === finalInput.admittedItemId
  ) {
    return withFinalInputWarning(
      {
        ...aggregate,
        finalInput: {
          ...finalInput,
          obligation: "settled",
          settledByTerminalObservation: true,
          quietDeadline: observationAt(observation) + 1_000,
        },
      },
      "participant_transcription_failed",
    );
  }

  if (observation.kind === "nothing_to_settle" && observation.commandId === finalInput.effectId) {
    return {
      ...aggregate,
      finalInput: {
        ...finalInput,
        obligation: "settled",
        quietDeadline: finalInput.quietDeadline,
      },
    };
  }

  return aggregate;
}

export function isBeyondFinalInputFence(
  finalInput: FinalInputState,
  observation: ProviderObservationOrder,
): boolean {
  return (
    observation.generation > finalInput.fence.generation ||
    (observation.generation === finalInput.fence.generation &&
      observation.sequence > finalInput.fence.sequence)
  );
}

export function activeInputItemIdForState(state: InterviewFinalizationState): string | null {
  return state.stage === "live" || state.stage === "draining" || state.stage === "closing_provider"
    ? state.activeInputItemId
    : null;
}

export function withFinalInputWarning(
  aggregate: InterviewFinalizationAggregate,
  warning: FinalInputWarning | "post_end_input_leaked",
): InterviewFinalizationAggregate {
  const state = aggregate.state;
  if (state.stage === "live" || state.stage === "finalizing" || state.stage === "ended") {
    return aggregate;
  }
  const finalInputWarning: FinalInputWarning | null =
    warning === "post_end_input_leaked" ? stateWarningForFinalInput(aggregate) : warning;
  return {
    ...aggregate,
    finalInput:
      aggregate.finalInput === null
        ? null
        : {
            ...aggregate.finalInput,
            warning: finalInputWarning,
          },
    state: {
      ...state,
      warnings: addWarning([...state.warnings], warning),
    },
  };
}

export function stateWarningForFinalInput(
  aggregate: InterviewFinalizationAggregate,
): FinalInputWarning | null {
  return aggregate.finalInput?.warning ?? null;
}

export function settleFinalInputAtQuiet(
  aggregate: InterviewFinalizationAggregate,
  at: number,
): InterviewFinalizationAggregate {
  const finalInput = aggregate.finalInput;
  if (
    finalInput === null ||
    aggregate.state.stage !== "draining" ||
    at < finalInput.quietDeadline ||
    !isFinalInputCommitSettled(aggregate)
  ) {
    return aggregate;
  }
  // An execution that answers the closure itself is awaited; otherwise one quiet second after
  // closure settles an answer Runtime does not hold.
  if (finalInput.obligation === "awaiting_item" && !finalInput.answerFollows) {
    const nextAggregate = {
      ...aggregate,
      finalInput: {
        ...finalInput,
        obligation: "settled" as const,
        quietDeadline: drainCheckpointAt(aggregate.state),
      },
    };
    if (!finalInput.inputToSettle) return nextAggregate;
    const warned = withFinalInputWarning(nextAggregate, "final_input_may_be_incomplete");
    return finalInput.warning === null
      ? warned
      : {
          ...warned,
          finalInput:
            warned.finalInput === null
              ? null
              : { ...warned.finalInput, warning: finalInput.warning },
        };
  }
  return aggregate;
}

export function settleFinalInputAtDrain(
  aggregate: InterviewFinalizationAggregate,
): InterviewFinalizationAggregate {
  const finalInput = aggregate.finalInput;
  if (
    finalInput === null ||
    (aggregate.state.stage !== "draining" && aggregate.state.stage !== "closing_provider")
  )
    return aggregate;
  if (finalInput.obligation === "settled") return aggregate;
  return withFinalInputWarning(
    {
      ...aggregate,
      finalInput: {
        ...finalInput,
        obligation: "settled",
        quietDeadline:
          aggregate.state.stage === "draining"
            ? drainCheckpointAt(aggregate.state)
            : aggregate.state.finalizationCutoffAt,
      },
    },
    finalInput.warning ?? "final_input_may_be_incomplete",
  );
}

export function deferFinalInputQuietDeadlineToDrain(
  aggregate: InterviewFinalizationAggregate,
  at: number,
): InterviewFinalizationAggregate {
  if (
    aggregate.state.stage !== "draining" ||
    aggregate.finalInput === null ||
    at < aggregate.finalInput.quietDeadline ||
    aggregate.finalInput.quietDeadline === drainCheckpointAt(aggregate.state)
  ) {
    return aggregate;
  }
  return {
    ...aggregate,
    finalInput: { ...aggregate.finalInput, quietDeadline: drainCheckpointAt(aggregate.state) },
  };
}

/**
 * Whether the input closure's settlement was carried out: it was dispatched and not refused, or
 * Runtime already held the answer, which needs no settling.
 */
export function isFinalInputCommitSettled(aggregate: InterviewFinalizationAggregate): boolean {
  const finalInput = aggregate.finalInput;
  if (finalInput === null) return true;
  const effect = aggregate.state.effects.find((candidate) => candidate.id === finalInput.effectId);
  if (
    effect?.kind === "close_input" &&
    effect.heldItemId !== null &&
    effect.heldItemId === finalInput.admittedItemId
  )
    return true;
  return (
    effect !== undefined &&
    effect.acceptance !== "rejected" &&
    (effect.status === "dispatched" || effect.acceptance === "benign_rejection")
  );
}

export function observeLiveProvider(
  state: FinalizationLiveState,
  observation: Exclude<
    FinalizationObservation,
    {
      kind:
        | "end_requested"
        | "effect_outcome"
        | "interrupted_effects_recovered"
        | "transcript_digest_computed"
        | "deadline_reached";
    }
  >,
): FinalizationLiveState {
  switch (observation.kind) {
    case "participant_answer_created":
      return { ...state, activeInputItemId: observation.itemId };
    case "participant_answer_transcribed":
    case "participant_answer_transcription_failed":
      return state.activeInputItemId === observation.itemId
        ? { ...state, activeInputItemId: null }
        : state;
    case "reply_started":
      return { ...state, activeResponseId: observation.responseId };
    case "reply_generated":
    case "reply_cancelled":
      return state.activeResponseId === observation.responseId
        ? { ...state, activeResponseId: null }
        : state;
    case "provider_finish_interview_rejected":
      return observation.responseId !== undefined &&
        observation.responseStatus !== undefined &&
        state.activeResponseId === observation.responseId
        ? { ...state, activeResponseId: null }
        : state;
    case "reply_delivery_started":
      return { ...state, outputAudioActive: true };
    case "reply_delivery_stopped":
      return { ...state, outputAudioActive: false };
    case "session_closed_observed": {
      const providerCloseBarrier = providerCloseBarrierForObservation(observation);
      const containedState = settleSocketContainmentEffectsForClosedSession(state);
      return providerCloseBarrier === undefined
        ? { ...containedState, sessionClosed: true }
        : { ...containedState, sessionClosed: true, providerCloseBarrier };
    }
    default:
      return state;
  }
}

export function observeEndingProvider(
  state: FinalizationDrainingState | FinalizationClosingProviderState,
  admittedInputItemId: string | null,
  observation: Exclude<
    FinalizationObservation,
    {
      kind:
        | "end_requested"
        | "effect_outcome"
        | "interrupted_effects_recovered"
        | "transcript_digest_computed"
        | "deadline_reached";
    }
  >,
): FinalizationDrainingState | FinalizationClosingProviderState {
  switch (observation.kind) {
    case "participant_answer_created": {
      const knownAdmittedItem = admittedInputItemId === observation.itemId;
      return {
        ...state,
        activeInputItemId: knownAdmittedItem ? observation.itemId : state.activeInputItemId,
        warnings:
          admittedInputItemId !== null && !knownAdmittedItem
            ? addWarning([...state.warnings], "post_end_input_leaked")
            : state.warnings,
      };
    }
    case "participant_answer_transcribed":
      if (admittedInputItemId !== observation.itemId) return state;
      return {
        ...state,
        activeInputItemId:
          state.activeInputItemId === observation.itemId ? null : state.activeInputItemId,
      };
    case "participant_answer_transcription_failed":
      if (admittedInputItemId !== observation.itemId) return state;
      return {
        ...state,
        activeInputItemId:
          state.activeInputItemId === observation.itemId ? null : state.activeInputItemId,
        warnings: addWarning([...state.warnings], "participant_transcription_failed"),
      };
    case "reply_started":
      return {
        ...state,
        activeResponseId: observation.responseId,
      };
    case "reply_generated":
    case "reply_cancelled":
      return state.activeResponseId === observation.responseId
        ? { ...state, activeResponseId: null }
        : state;
    case "provider_finish_interview_rejected":
      return observation.responseId !== undefined &&
        observation.responseStatus !== undefined &&
        state.activeResponseId === observation.responseId
        ? { ...state, activeResponseId: null }
        : state;
    case "reply_delivery_started":
      return {
        ...state,
        outputAudioActive: true,
        warnings: addWarning([...state.warnings], "post_end_output_leaked"),
      };
    case "reply_delivery_stopped":
      return { ...state, outputAudioActive: false };
    case "session_closed_observed": {
      const providerCloseBarrier = providerCloseBarrierForObservation(observation);
      const containedState = settleSocketContainmentEffectsForClosedSession(state);
      const warnings = reconcileProviderClosureWarnings(
        state.warnings,
        state.activeInputItemId !== null,
      );
      return providerCloseBarrier === undefined
        ? { ...containedState, sessionClosed: true, warnings }
        : { ...containedState, sessionClosed: true, providerCloseBarrier, warnings };
    }
    default:
      return state;
  }
}

export function observeTranscript(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservation,
  stateBeforeObservation: InterviewFinalizationState,
): InterviewFinalizationAggregate {
  aggregate = observeTranscriptProof(aggregate, observation, stateBeforeObservation);
  const transcripts = transcriptObservations(observation);
  if (
    transcripts.length === 0 ||
    aggregate.state.stage === "ended" ||
    !isTranscriptObservationAdmitted(aggregate, stateBeforeObservation, observation)
  ) {
    return aggregate;
  }
  const capture = transcripts.reduce(
    (current, transcript) =>
      upsertTranscriptItem(
        current,
        shouldFreezeClosingTranscriptText(aggregate, transcript)
          ? withoutTranscriptText(transcript)
          : transcript,
      ),
    aggregate.transcriptCapture,
  );
  const before = getSerializedTranscriptTurns(aggregate.transcriptCapture);
  const after = getSerializedTranscriptTurns(capture);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return { ...aggregate, transcriptCapture: capture };
  }
  const revision = aggregate.transcriptRevision + 1;
  return {
    ...aggregate,
    transcriptCapture: capture,
    transcriptRevision: revision,
    transcriptDigest: null,
  };
}

export function withoutTranscriptText(transcript: TranscriptObservation): TranscriptObservation {
  const { text: _text, ...withoutText } = transcript;
  return withoutText;
}

export function isTranscriptObservationAdmitted(
  aggregate: InterviewFinalizationAggregate,
  state: InterviewFinalizationState,
  observation: FinalizationObservation,
): boolean {
  if (state.stage === "finalizing" || state.stage === "ended") return false;
  if (
    (observation.kind === "participant_answer_transcribed" ||
      observation.kind === "participant_answer_transcription_failed" ||
      (observation.kind === "transcript_item_observed" && observation.role === "participant")) &&
    aggregate.applicationTranscriptProof.obligations.some(
      (item) => item.itemId === observation.itemId && item.role === "participant",
    )
  )
    return true;
  if (state.stage === "live") {
    if (aggregate.finalInput === null) return true;
    if (observation.kind === "participant_answer_transcribed")
      return (
        observation.itemId === aggregate.finalInput.admittedItemId ||
        aggregate.applicationTranscriptProof.obligations.some(
          (item) => item.itemId === observation.itemId && item.role === "participant",
        )
      );
    const itemId = "itemId" in observation ? observation.itemId : undefined;
    const responseId = "responseId" in observation ? observation.responseId : undefined;
    if (
      itemId !== undefined &&
      aggregate.applicationTranscriptProof.obligations.some((item) => item.itemId === itemId)
    )
      return true;
    if (responseId !== undefined) {
      if (responseId === aggregate.gracefulCompletion?.responseId) return true;
      const node = aggregate.conversationNodeExecution;
      // The reply a deadline's closing cut keeps its text under its own visit, as Stop keeps
      // it. Only its text is admitted: its finish reports, like its tool calls, stay refused.
      if (
        isFinishingNode(node) &&
        node.reservation.cutResponseId === responseId &&
        (observation.kind === "agent_transcript_finalized" ||
          observation.kind === "transcript_item_observed" ||
          observation.kind === "reply_generated" ||
          observation.kind === "reply_cancelled")
      )
        return true;
      const scope = aggregate.providerResponses.find(
        (response) => response.responseId === responseId,
      )?.conversationScope;
      const visit = aggregate.conversationVisit;
      return (
        node?.dispatch !== undefined &&
        node.kind !== "retained_output" &&
        visit !== undefined &&
        scope?.operationId === visit.operationId &&
        scope.visitId === visit.visitId
      );
    }
    if (observation.kind === "transcript_item_observed" && observation.role === "participant")
      return observation.itemId === aggregate.finalInput.admittedItemId;
    return false;
  }

  if (observation.kind === "participant_answer_transcribed") {
    return admittedFinalInputItemId(aggregate) === observation.itemId;
  }

  if (
    observation.kind === "reply_generated" ||
    observation.kind === "reply_cancelled" ||
    observation.kind === "provider_finish_interview_observed" ||
    observation.kind === "provider_finish_interview_rejected"
  ) {
    return (
      aggregate.retainedInterviewerResponseId === observation.responseId &&
      state.admittedResponseId === observation.responseId &&
      (observation.kind !== "provider_finish_interview_observed" ||
        observation.callId === aggregate.gracefulCompletion?.callId)
    );
  }

  if (observation.kind === "agent_transcript_finalized") {
    const knownEligibleItem =
      completedReasonOf(aggregate.applicationTranscriptProof) === "agent_requested_end" &&
      aggregate.applicationTranscriptProof.obligations.some(
        (item) =>
          item.itemId === observation.itemId &&
          item.role === "conversationAgent" &&
          item.status !== "non_transcript",
      ) &&
      aggregate.transcriptCapture.items.some(
        (item) =>
          item.itemId === observation.itemId &&
          (observation.responseId === undefined || item.responseId === observation.responseId),
      );
    return (
      knownEligibleItem ||
      (aggregate.retainedInterviewerResponseId !== undefined &&
        responseMatchesAdmittedItemOrResponse(
          aggregate,
          state.admittedResponseId,
          observation.itemId,
          observation.responseId,
        ))
    );
  }

  if (observation.kind === "transcript_item_observed") {
    return observation.role === "participant"
      ? admittedFinalInputItemId(aggregate) === observation.itemId
      : aggregate.retainedInterviewerResponseId !== undefined &&
          responseMatchesAdmittedItemOrResponse(
            aggregate,
            state.admittedResponseId,
            observation.itemId,
            observation.responseId,
          );
  }

  return false;
}

export function responseMatchesAdmittedItemOrResponse(
  aggregate: InterviewFinalizationAggregate,
  admittedResponseId: string | null,
  itemId: string,
  responseId: string | undefined,
): boolean {
  if (admittedResponseId === null) return false;
  if (responseId !== undefined) return responseId === admittedResponseId;
  return aggregate.transcriptCapture.items.some(
    (item) => item.itemId === itemId && item.responseId === admittedResponseId,
  );
}

export function shouldFreezeClosingTranscriptText(
  aggregate: InterviewFinalizationAggregate,
  transcript: TranscriptObservation,
): boolean {
  if (
    aggregate.retainedInterviewerResponseId !== undefined &&
    aggregate.transcriptCapture.items.some(
      (item) => item.itemId === transcript.itemId && item.nonTranscript === true,
    )
  )
    return true;
  if (
    aggregate.applicationTranscriptProof?.obligations.some(
      (item) =>
        item.itemId === transcript.itemId &&
        (item.status === "failed" || item.status === "non_transcript"),
    )
  )
    return true;
  if (
    (aggregate.gracefulCompletion === null &&
      aggregate.retainedInterviewerResponseId === undefined) ||
    transcript.role !== "conversationAgent" ||
    transcript.text === undefined
  ) {
    return false;
  }
  return aggregate.transcriptCapture.items.some(
    (item) =>
      item.itemId === transcript.itemId &&
      item.responseId ===
        (aggregate.retainedInterviewerResponseId ?? aggregate.gracefulCompletion?.responseId) &&
      item.text !== undefined,
  );
}

export type TranscriptObservation = Readonly<{
  itemId: string;
  previousItemId?: string;
  role?: "participant" | "conversationAgent";
  text?: string;
  nonTranscript?: boolean;
  responseId?: string;
  outputIndex?: number;
  contentIndex?: number;
}>;

export type TranscriptObservationDraft = {
  -readonly [Key in keyof TranscriptObservation]: TranscriptObservation[Key];
};

export function transcriptObservations(
  observation: FinalizationObservation,
): readonly TranscriptObservation[] {
  if (observation.kind === "participant_answer_transcribed") {
    const transcript: TranscriptObservationDraft = {
      itemId: observation.itemId,
      role: "participant",
    };
    if (observation.text !== undefined) transcript.text = observation.text;
    return [transcript];
  }
  if (observation.kind === "agent_transcript_finalized") {
    const transcript: TranscriptObservationDraft = {
      itemId: observation.itemId,
      role: "conversationAgent",
    };
    if (observation.text !== undefined) transcript.text = observation.text;
    if (observation.responseId !== undefined) transcript.responseId = observation.responseId;
    return [transcript];
  }
  if (
    observation.kind === "reply_generated" ||
    observation.kind === "reply_cancelled" ||
    observation.kind === "provider_finish_interview_observed" ||
    observation.kind === "provider_finish_interview_rejected"
  ) {
    return (observation.transcriptItems ?? []).map((item) => {
      const transcript: TranscriptObservationDraft = { itemId: item.itemId };
      if (item.nonTranscript !== undefined) transcript.nonTranscript = item.nonTranscript;
      if (item.text !== undefined) transcript.text = item.text;
      if (item.role !== undefined) transcript.role = item.role;
      if (item.responseId !== undefined) transcript.responseId = item.responseId;
      if (item.outputIndex !== undefined) transcript.outputIndex = item.outputIndex;
      return transcript;
    });
  }
  if (observation.kind === "transcript_item_observed") {
    const transcript: TranscriptObservationDraft = { itemId: observation.itemId };
    if (observation.nonTranscript !== undefined)
      transcript.nonTranscript = observation.nonTranscript;
    if (observation.previousItemId !== undefined) {
      transcript.previousItemId = observation.previousItemId;
    }
    if (observation.role !== undefined) transcript.role = observation.role;
    if (observation.responseId !== undefined) transcript.responseId = observation.responseId;
    if (observation.outputIndex !== undefined) transcript.outputIndex = observation.outputIndex;
    if (observation.contentIndex !== undefined) transcript.contentIndex = observation.contentIndex;
    return [transcript];
  }
  return [];
}

export function settleSocketContainmentEffectsForClosedSession(
  state: FinalizationLiveState,
): FinalizationLiveState;

export function settleSocketContainmentEffectsForClosedSession(
  state: FinalizationDrainingState,
): FinalizationDrainingState;

export function settleSocketContainmentEffectsForClosedSession(
  state: FinalizationClosingProviderState,
): FinalizationClosingProviderState;

export function settleSocketContainmentEffectsForClosedSession(
  state: FinalizationFinalizingState,
): FinalizationFinalizingState;

export function settleSocketContainmentEffectsForClosedSession(
  state: FinalizationDrainingState | FinalizationClosingProviderState,
): FinalizationDrainingState | FinalizationClosingProviderState;

export function settleSocketContainmentEffectsForClosedSession(
  state: Exclude<InterviewFinalizationState, FinalizationEndedState>,
): Exclude<InterviewFinalizationState, FinalizationEndedState> {
  const effects = state.effects.map((effect): FinalizationEffectRecord => {
    // A closed session already closed input; settling an answer Runtime does not hold is still owed.
    if (
      ((effect.kind !== "close_input" || effect.heldItemId === null) &&
        effect.kind !== "discard_later_input" &&
        effect.kind !== "cancel_reply" &&
        effect.kind !== "stop_output") ||
      effect.status === "dispatched"
    ) {
      return effect;
    }
    return { ...effect, status: "dispatched", acceptance: "benign_rejection" };
  });
  if (effects.every((effect, index) => effect === state.effects[index])) return state;
  switch (state.stage) {
    case "live":
      return { ...state, effects };
    case "draining":
      return { ...state, effects };
    case "closing_provider":
      return { ...state, effects };
    case "finalizing":
      return { ...state, effects };
  }
}

export function hasPendingRetainedInterviewerText(
  aggregate: InterviewFinalizationAggregate,
): boolean {
  if (aggregate.retainedInterviewerResponseId === undefined) return false;
  const responseItems = aggregate.transcriptCapture.items.filter(
    (item) =>
      item.responseId === aggregate.retainedInterviewerResponseId &&
      item.role === "conversationAgent",
  );
  const items = responseItems.filter((item) => item.nonTranscript !== true);
  if (items.length > 0) return items.some((item) => item.text === undefined);
  if (
    aggregate.applicationTranscriptProof.inventoriedResponseIds?.includes(
      aggregate.retainedInterviewerResponseId,
    ) === true &&
    aggregate.providerResponses.some(
      (response) =>
        response.responseId === aggregate.retainedInterviewerResponseId &&
        response.status === "completed",
    ) &&
    aggregate.gracefulCompletion?.responseId === aggregate.retainedInterviewerResponseId
  )
    return false;
  return !(
    responseItems.length > 0 &&
    aggregate.providerResponses.some(
      (response) =>
        response.responseId === aggregate.retainedInterviewerResponseId &&
        "nonTranscriptInventoryComplete" in response &&
        response.nonTranscriptInventoryComplete === true,
    )
  );
}

export function hasPendingResultObligation(aggregate: InterviewFinalizationAggregate): boolean {
  if (aggregate.state.stage !== "draining" && aggregate.state.stage !== "closing_provider") {
    return false;
  }
  const state = aggregate.state;
  return (
    hasPendingRetainedInterviewerText(aggregate) ||
    ((aggregate.applicationTranscriptProof.interrupted ||
      completedReasonOf(aggregate.applicationTranscriptProof) !== undefined) &&
      (aggregate.applicationTranscriptProof.obligations.some((item) => item.status === "pending") ||
        !hasWinningResponseInventory(aggregate))) ||
    (aggregate.finalInput?.obligation !== undefined &&
      aggregate.finalInput.obligation !== "settled") ||
    state.activeInputItemId !== null ||
    state.activeResponseId !== null
  );
}

export function shouldWarnForGracefulDelivery(aggregate: InterviewFinalizationAggregate): boolean {
  const gracefulCompletion = aggregate.gracefulCompletion;
  if (gracefulCompletion === null || gracefulCompletion.participantMediaSafetyOverride) {
    return false;
  }
  return (
    aggregate.unidentifiedOutputAudioActive ||
    gracefulCompletion.responseSettlement !== "completed" ||
    gracefulCompletion.outputAudioSettlement !== "stopped"
  );
}

export function isDuplicateProviderObservation(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservation,
): boolean {
  const sequence = providerSequenceFor(observation);
  const generation = providerGenerationFor(observation);
  if (sequence === null || generation === null) return false;
  if (generation < aggregate.providerGeneration) return true;
  return generation === aggregate.providerGeneration && sequence < aggregate.nextProviderSequence;
}

export function isMatchingSettledFinalInputObservation(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservation,
): boolean {
  return (
    aggregate.finalInput?.settledByTerminalObservation === true &&
    aggregate.finalInput.admittedItemId !== null &&
    (observation.kind === "participant_answer_transcribed" ||
      observation.kind === "participant_answer_transcription_failed") &&
    observation.itemId === aggregate.finalInput.admittedItemId
  );
}

export function isOrderedProviderObservation(
  observation: FinalizationObservation,
): observation is OrderedProviderFinalizationObservation {
  return (
    "sequence" in observation &&
    typeof observation.sequence === "number" &&
    "generation" in observation &&
    typeof observation.generation === "number"
  );
}

export function isAfterProviderCloseBarrier(
  state: FinalizationDrainingState | FinalizationClosingProviderState,
  observation: OrderedProviderFinalizationObservation,
): boolean {
  const barrier = state.providerCloseBarrier;
  if (barrier === undefined) return false;
  return (
    observation.generation > barrier.generation ||
    (observation.generation === barrier.generation && observation.sequence > barrier.sequence)
  );
}

export function isProviderCloseBarrierSettled(aggregate: InterviewFinalizationAggregate): boolean {
  if (aggregate.state.stage !== "closing_provider" || !aggregate.state.sessionClosed) {
    return false;
  }
  const hangup = aggregate.state.effects.find((effect) => effect.kind === "release_session");
  if (hangup?.status === "pending" || hangup?.status === "sending") return false;
  const barrier = aggregate.state.providerCloseBarrier;
  if (barrier === undefined) return true;
  const accepted = aggregate.acceptedProviderOrder;
  return accepted !== null && compareProviderOrder(accepted, barrier) >= 0;
}

export function providerCloseBarrierForObservation(
  observation: Extract<ProviderFinalizationObservation, { kind: "session_closed_observed" }>,
): ProviderObservationOrder {
  return { generation: observation.generation, sequence: observation.sequence };
}

export function compareProviderOrder(
  left: Readonly<{ generation: number; sequence: number }>,
  right: Readonly<{ generation: number; sequence: number }>,
): number {
  if (left.generation !== right.generation) return left.generation - right.generation;
  return left.sequence - right.sequence;
}

export function earliestProviderCloseBarrier(
  left: ProviderObservationOrder | undefined,
  right: ProviderObservationOrder | undefined,
): ProviderObservationOrder | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left.generation !== right.generation) {
    return left.generation < right.generation ? left : right;
  }
  return left.sequence <= right.sequence ? left : right;
}

export function providerSequenceFor(observation: FinalizationObservation): number | null {
  return "sequence" in observation && typeof observation.sequence === "number"
    ? observation.sequence
    : null;
}

export function providerGenerationFor(observation: FinalizationObservation): number | null {
  return "generation" in observation && typeof observation.generation === "number"
    ? observation.generation
    : null;
}

export type SerializedTranscriptItemDraft = {
  -readonly [Key in keyof SerializedTranscriptItem]: SerializedTranscriptItem[Key];
};

export function upsertTranscriptItem(
  capture: SerializedTranscriptCapture,
  observation: TranscriptObservation,
): SerializedTranscriptCapture {
  const items = [...capture.items];
  const index = items.findIndex((item) => item.itemId === observation.itemId);
  const existing =
    index === -1
      ? { itemId: observation.itemId, firstSeenSequence: capture.sequence + 1 }
      : (items[index] ?? { itemId: observation.itemId, firstSeenSequence: capture.sequence + 1 });
  const text = observation.text;
  const next: SerializedTranscriptItemDraft = { ...existing };
  if (observation.previousItemId !== undefined) {
    next.previousItemId = observation.previousItemId;
  }
  if (observation.role !== undefined) next.role = observation.role;
  if (text !== undefined && text.trim().length > 0) next.text = text;
  if (observation.responseId !== undefined) next.responseId = observation.responseId;
  if (observation.nonTranscript !== undefined && next.nonTranscript !== true)
    next.nonTranscript = observation.nonTranscript;
  if (observation.outputIndex !== undefined) next.outputIndex = observation.outputIndex;
  if (observation.contentIndex !== undefined) next.contentIndex = observation.contentIndex;
  next.finalSequence = capture.sequence + 1;
  if (index === -1) items.push(next);
  else items[index] = next;
  return { sequence: capture.sequence + 1, items };
}

export type ActiveFinalizationState =
  | FinalizationDrainingState
  | FinalizationClosingProviderState
  | FinalizationFinalizingState;

export function reconcileProviderClosureWarnings(
  warnings: readonly ResultWarning[],
  providerClosedWithPendingInput: boolean,
): ResultWarning[] {
  const reconciled = warnings.filter(
    (warning) =>
      warning !== "session_release_failed" &&
      warning !== "session_release_timed_out" &&
      warning !== "session_release_uncertain",
  );
  return providerClosedWithPendingInput
    ? addWarning(reconciled, "session_closed_with_pending_input")
    : reconciled;
}

export function observeTranscriptProof(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservation,
  state: InterviewFinalizationState,
): InterviewFinalizationAggregate {
  const proof = aggregate.applicationTranscriptProof;
  if (proof === undefined || state.stage === "ended" || state.stage === "finalizing")
    return aggregate;
  const live = state.stage === "live" && aggregate.finalInput === null;
  const admittedInput = admittedFinalInputItemId(aggregate);
  const candidates: TranscriptObligation[] = [];
  if (
    observation.kind === "participant_answer_created" &&
    (live || observation.itemId === admittedInput)
  ) {
    candidates.push({ itemId: observation.itemId, role: "participant", status: "pending" });
  }
  if (
    observation.kind === "participant_answer_transcription_failed" &&
    (live ||
      observation.itemId === admittedInput ||
      isTranscriptObservationAdmitted(aggregate, state, observation))
  ) {
    candidates.push({ itemId: observation.itemId, role: "participant", status: "failed" });
  }
  if (
    observation.kind === "transcript_item_observed" &&
    observation.nonTranscript === true &&
    (live || isTranscriptObservationAdmitted(aggregate, state, observation))
  ) {
    candidates.push({
      itemId: observation.itemId,
      role: observation.role ?? "conversationAgent",
      status: "non_transcript",
    });
  }
  if (isTranscriptObservationAdmitted(aggregate, state, observation)) {
    for (const item of transcriptObservations(observation)) {
      if (item.role === undefined) continue;
      candidates.push({
        itemId: item.itemId,
        role: item.role,
        status:
          item.nonTranscript === true
            ? "non_transcript"
            : item.text !== undefined
              ? "captured"
              : observation.kind === "agent_transcript_finalized" ||
                  observation.kind === "participant_answer_transcribed"
                ? "failed"
                : "pending",
      });
    }
  }
  const inventoriedResponseIds = [...(proof.inventoriedResponseIds ?? [])];
  if (
    (observation.kind === "reply_generated" ||
      observation.kind === "reply_cancelled" ||
      observation.kind === "provider_finish_interview_observed" ||
      observation.kind === "provider_finish_interview_rejected") &&
    observation.responseId !== undefined &&
    observation.transcriptInventoryComplete === true &&
    isTranscriptObservationAdmitted(aggregate, state, observation) &&
    !inventoriedResponseIds.includes(observation.responseId)
  ) {
    inventoriedResponseIds.push(observation.responseId);
  }
  if (
    candidates.length === 0 &&
    inventoriedResponseIds.length === (proof.inventoriedResponseIds?.length ?? 0)
  )
    return aggregate;
  const obligations = [...proof.obligations];
  for (const candidate of candidates) {
    const index = obligations.findIndex((item) => item.itemId === candidate.itemId);
    if (index < 0) obligations.push(candidate);
    else if (obligations[index]?.status === "pending") obligations[index] = candidate;
  }
  return {
    ...aggregate,
    applicationTranscriptProof: { ...proof, obligations, inventoriedResponseIds },
  };
}

export function hasUnresolvedInputBufferProof(aggregate: InterviewFinalizationAggregate): boolean {
  const input = aggregate.finalInput;
  if (input === null || !input.inputToSettle || input.admittedItemId !== null) return false;
  return !aggregate.state.effects.some(
    (effect) =>
      effect.id === input.effectId &&
      effect.kind === "close_input" &&
      effect.acceptance === "benign_rejection",
  );
}

export function hasWinningResponseInventory(aggregate: InterviewFinalizationAggregate): boolean {
  const proof = aggregate.applicationTranscriptProof;
  return (
    completedReasonOf(proof) !== "agent_requested_end" ||
    (!isFinishingNode(aggregate.conversationNodeExecution) &&
      aggregate.conversationNodeExecution?.dispatch?.status === "complete" &&
      aggregate.gracefulCompletion === null) ||
    nodeLimitation(aggregate.conversationNodeExecution) !== undefined ||
    (aggregate.gracefulCompletion !== null &&
      proof.inventoriedResponseIds?.includes(aggregate.gracefulCompletion.responseId) === true)
  );
}

export function readTranscriptIncompleteReasons(
  aggregate: InterviewFinalizationAggregate,
  proof: NonNullable<InterviewFinalizationAggregate["applicationTranscriptProof"]>,
): readonly RuntimeTranscriptIncompleteReason[] {
  const reasons: RuntimeTranscriptIncompleteReason[] = [];
  const nodeInventoryGap =
    nodeLimitation(aggregate.conversationNodeExecution) !== undefined &&
    !hasCompleteNodeTranscriptInventory(
      aggregate.conversationVisit,
      aggregate.providerResponses,
      proof.inventoriedResponseIds,
    );
  if (proof.evidenceGap === true || nodeInventoryGap)
    reasons.push({ kind: "conversation_evidence_gap" });
  for (const item of proof.obligations) {
    if (item.status === "pending") {
      reasons.push({
        kind: "eligible_transcript_item_pending",
        itemId: item.itemId,
        role: item.role,
      });
    }
    if (item.status === "failed") {
      reasons.push({
        kind: "eligible_transcript_item_failed",
        itemId: item.itemId,
        role: item.role,
      });
    }
  }
  if (hasUnresolvedInputBufferProof(aggregate)) {
    reasons.push({ kind: "final_input_unresolved" });
  }
  if (!hasWinningResponseInventory(aggregate) && aggregate.gracefulCompletion !== null) {
    reasons.push({
      kind: "closing_response_inventory_unresolved",
      responseId: aggregate.gracefulCompletion.responseId,
    });
  }
  return reasons;
}

/** Coherent native evidence over the legacy host encoding. */
export type ConversationEvidence = Readonly<{
  pending: boolean;
  transcriptIncompleteReasons: readonly RuntimeTranscriptIncompleteReason[];
  closureObserved: boolean;
  closureReadyForFreeze: boolean;
}>;

export function projectConversationEvidence(
  aggregate: InterviewFinalizationAggregate,
): ConversationEvidence {
  return {
    pending: hasPendingResultObligation(aggregate),
    transcriptIncompleteReasons: readTranscriptIncompleteReasons(
      aggregate,
      aggregate.applicationTranscriptProof,
    ),
    closureObserved: "sessionClosed" in aggregate.state && aggregate.state.sessionClosed,
    closureReadyForFreeze: isProviderCloseBarrierSettled(aggregate),
  };
}

export type ConversationObservationHandoff = Readonly<{
  aggregate: InterviewFinalizationAggregate;
  evidence: ConversationEvidence;
  effects: readonly FinalizationEffectRecord[];
}>;

export function observeConversation(
  aggregate: InterviewFinalizationAggregate,
  observation: ProviderFinalizationObservation,
): ConversationObservationHandoff {
  let next = aggregate;
  const before = next.state;
  next = observeProviderResponseEvidence(next, observation);
  if (before.stage !== "finalizing" && before.stage !== "ended") {
    next = {
      ...next,
      state: observeProvider(next.state, admittedFinalInputItemId(next), observation),
    };
    next = observeFinalInput(next, observation, before);
    next = observeTranscript(next, observation, before);
  }
  next = settleObservedProviderEffectConsequences(next, observation);
  const effects: FinalizationEffectRecord[] = [];
  if (
    next.state.stage === "draining" ||
    next.state.stage === "closing_provider" ||
    (next.state.stage === "live" && next.conversationNodeExecution?.kind === "retained_output")
  ) {
    if (
      (observation.kind === "reply_started" ||
        observation.kind === "reply_delivery_started" ||
        observation.kind === "provider_finish_interview_observed") &&
      observation.responseId !== undefined &&
      observation.responseId !==
        (next.state.stage === "live"
          ? next.gracefulCompletion?.responseId
          : next.state.admittedResponseId)
    ) {
      addEffect(next, effects, { kind: "cancel_reply", responseId: observation.responseId });
    }
  }
  return { aggregate: next, evidence: projectConversationEvidence(next), effects };
}

export function observeConversationCompletion(
  aggregate: InterviewFinalizationAggregate,
  observation: Extract<
    ProviderFinalizationObservation,
    { kind: "provider_finish_interview_observed" }
  >,
): GracefulCompletionState {
  const response = aggregate.providerResponses.find(
    (candidate) => candidate.responseId === observation.responseId,
  );
  const responseSettlement =
    observation.responseStatus ??
    (response?.status === "active" ||
    response?.status === "unobserved" ||
    response?.status === undefined
      ? "pending"
      : response.status);
  const gracefulCompletion: GracefulCompletionState = {
    callId: observation.callId,
    responseId: observation.responseId,
    itemId: observation.itemId ?? null,
    responseSettlement,
    outputAudioSettlement:
      response?.outputAudio === "stopped"
        ? "stopped"
        : response?.outputAudio === "active"
          ? "active"
          : "pending",
    participantMediaSafetyOverride: false,
  };
  return gracefulCompletion;
}

export function readConversationCompletionReference(
  aggregate: InterviewFinalizationAggregate,
): GracefulCompletionState | null {
  return aggregate.gracefulCompletion;
}

/** Conversation interprets one admitted original receipt before semantic settlement. */
export function prepareConversationReceipt(
  aggregate: InterviewFinalizationAggregate,
  observation: ProviderFinalizationObservation,
  agent?: RuntimeImplementation,
  selected: import("./implementationContracts.ts").SelectedConversation | null = null,
  reportingAdmission?: import("./implementationContracts.ts").ConversationAdmission,
  acceptedAt?: number,
): ConversationSemanticEvidence {
  const decisions = new Map<
    import("./implementationContracts.ts").ConversationToolInvocation,
    RuntimeToolCallOutcome
  >();
  const evidence = interpretConversationReceipt(
    aggregate,
    observation,
    decisions,
    agent,
    selected,
    reportingAdmission,
    acceptedAt,
  );
  const toolCalls = describeToolCalls(aggregate, observation, decisions);
  return toolCalls.length === 0 ? evidence : { ...evidence, toolCalls };
}

/**
 * One Runtime tool-call payload per invocation the receipt carries, attributed to the visit
 * that received it. An invocation the receipt did not interpret is recorded as ignored.
 */
function describeToolCalls(
  aggregate: InterviewFinalizationAggregate,
  observation: ProviderFinalizationObservation,
  decisions: ReadonlyMap<
    import("./implementationContracts.ts").ConversationToolInvocation,
    RuntimeToolCallOutcome
  >,
): readonly RuntimeToolCallDescription[] {
  if (!("toolInvocations" in observation)) return [];
  const visit = aggregate.conversationVisit;
  return (observation.toolInvocations ?? []).map((invocation) => {
    const outcome = decisions.get(invocation) ?? {
      outcome: "ignored",
      reason: "not_interpreted",
    };
    const call = {
      toolName: invocation.toolName,
      toolCallId: invocation.callId ?? null,
      responseId: invocation.responseId ?? null,
      argumentsBytes: argumentsByteLength(invocation),
      state: visit?.state ?? null,
      visitId: visit?.visitId ?? null,
      operationId: visit?.operationId ?? null,
    };
    const located = visit?.context === undefined ? call : { ...call, context: visit.context };
    return { ...located, ...outcome };
  });
}

function argumentsByteLength(
  invocation: import("./implementationContracts.ts").ConversationToolInvocation,
): number | null {
  const value = invocation.arguments;
  if (value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? null : new TextEncoder().encode(text).byteLength;
}

function interpretConversationReceipt(
  aggregate: InterviewFinalizationAggregate,
  observation: ProviderFinalizationObservation,
  decisions: Map<
    import("./implementationContracts.ts").ConversationToolInvocation,
    RuntimeToolCallOutcome
  >,
  agent?: RuntimeImplementation,
  selected: import("./implementationContracts.ts").SelectedConversation | null = null,
  reportingAdmission?: import("./implementationContracts.ts").ConversationAdmission,
  acceptedAt?: number,
): ConversationSemanticEvidence {
  const execution = selected?.execution ?? null;
  let next = aggregate;
  const at = acceptedAt ?? observationAt(observation);
  let usageEvidence: ConversationSemanticEvidence["usageEvidence"] = [];
  if (isOrderedProviderObservation(observation)) {
    const barrier = aggregate.applicationTranscriptProof.closeBarrier;
    if (
      (barrier !== null && compareProviderOrder(observation, barrier) > 0) ||
      isDuplicateProviderObservation(aggregate, observation)
    ) {
      return {
        kind: "conversation_evidence_observed",
        snapshot: aggregate,
        effects: [],
        at,
        notification: "none",
        usageEvidence,
      };
    }
    next = {
      ...aggregate,
      nextProviderSequence:
        observation.generation > aggregate.providerGeneration
          ? observation.sequence + 1
          : Math.max(aggregate.nextProviderSequence, observation.sequence + 1),
      providerGeneration: Math.max(aggregate.providerGeneration, observation.generation),
      acceptedProviderOrder: { generation: observation.generation, sequence: observation.sequence },
    };
    usageEvidence = observeConversationUsage(
      observation,
      aggregate.state.stage,
      aggregate.runtimeUsage,
    );
    if (next.state.stage === "live") {
      next = {
        ...next,
        lastProviderObservationAt: Math.max(
          next.applicationTranscriptProof.liveAt,
          next.lastProviderObservationAt ?? 0,
          at,
        ),
      };
    }
    if (
      ((next.state.stage === "draining" || next.state.stage === "closing_provider") &&
        isAfterProviderCloseBarrier(next.state, observation)) ||
      isMatchingSettledFinalInputObservation(next, observation)
    ) {
      return {
        kind: "conversation_evidence_observed",
        snapshot: next,
        effects: [],
        at,
        notification: "none",
        usageEvidence,
      };
    }
  } else
    usageEvidence = observeConversationUsage(
      observation,
      aggregate.state.stage,
      aggregate.runtimeUsage,
    );
  const visit = next.conversationVisit;
  let transition: import("./conversationContracts.ts").ConversationTransitionDecision | undefined;
  let admittedTool: Readonly<{ responseId: string; toolCallId: string }> | undefined;
  const contract =
    visit === undefined || agent === undefined
      ? undefined
      : requireConversationState(agent.conversation, visit.state);
  // A response keeps the authority of its first admitted native receipt. After a
  // visit/recovery change, only a new response-start can establish a new scope.
  // Unknown late receipts remain evidence-only; later duplicates cannot upgrade them.
  if (visit !== undefined && "generation" in observation) {
    const responseIds = new Set([
      ...("responseId" in observation && observation.responseId !== undefined
        ? [observation.responseId]
        : []),
      ...("toolInvocations" in observation
        ? (observation.toolInvocations ?? []).flatMap((invocation) =>
            invocation.responseId === undefined ? [] : [invocation.responseId],
          )
        : []),
    ]);
    for (const responseId of responseIds) {
      const existing = next.providerResponses.find(
        (response) => response.responseId === responseId,
      );
      if (existing?.conversationScope !== undefined) continue;
      const establishesScope =
        next.state.stage === "live" &&
        ((visit.revision ?? 0) === 0 ||
          (existing === undefined && observation.kind === "reply_started"));
      next = {
        ...next,
        providerResponses: upsertProviderResponse(next.providerResponses, responseId, {
          status: existing?.status ?? "unobserved",
          conversationScope: establishesScope
            ? {
                runId: next.runId,
                visitId: visit.visitId,
                operationId: visit.operationId,
                generation: observation.generation,
              }
            : null,
        }),
      };
    }
  }
  if (
    agent !== undefined &&
    next.state.stage === "live" &&
    (visit === undefined || contract != null)
  )
    observation = interpretConversationTools(
      observation,
      agent,
      execution,
      visit !== undefined,
      (report, responseId, toolCallId) => {
        if (visit === undefined) return true;
        const admitted = reportingAdmission?.admit(report);
        if (admitted == null) return null;
        transition = admitted.transition;
        admittedTool = { responseId, toolCallId };
        return (
          transition.terminal ||
          (transition.target !== null &&
            selected !== null &&
            requireConversationState(agent.conversation, transition.target)
              ?.finishesParticipation === true &&
            selected.accepted.timers?.({
              liveAt: next.applicationTranscriptProof.liveAt,
              enteredAt: at,
              state: transition.target,
            }).retainedOutputCleanupAt !== undefined)
        );
      },
      (invocation) => {
        if (visit === undefined) return true;
        if (invocation.responseId === undefined) return (visit.revision ?? 0) === 0;
        const scope = next.providerResponses.find(
          (response) => response.responseId === invocation.responseId,
        )?.conversationScope;
        return (
          scope != null &&
          scope.runId === next.runId &&
          scope.visitId === visit.visitId &&
          scope.operationId === visit.operationId &&
          "generation" in observation &&
          scope.generation === observation.generation
        );
      },
      {
        known: (invocation) =>
          (selected?.agent ?? agent).interpretTool(structuredClone(invocation), null) !== null,
        decide: (invocation, outcome) => decisions.set(invocation, outcome),
        transition: () => transition,
      },
    );
  const handoff = observeConversation(next, observation);
  next = handoff.aggregate;
  if (visit !== undefined && transition?.target != null) {
    if (transition.terminal) {
      next = { ...next, conversationVisit: { ...visit, state: transition.target } };
      const timing = next.conversationNodeExecution;
      if (timing?.dispatch !== undefined)
        next = {
          ...next,
          conversationNodeExecution: {
            ...timing,
            dispatch: updateNodeDispatch(timing.dispatch, { status: "complete" }),
          },
        };
    } else if (agent !== undefined && selected !== null) {
      next = enterConversationNode(next, agent, selected.accepted, transition.target, {
        reason: "agent_requested_end",
        at,
        responseId: admittedTool?.responseId,
        toolCallId: admittedTool?.toolCallId,
        context: transition.context,
      });
    }
  }
  if (next.state.stage === "live" && observation.kind === "provider_finish_interview_observed") {
    const scope = next.providerResponses.find(
      (response) => response.responseId === observation.responseId,
    )?.conversationScope;
    let reference = observeConversationCompletion(next, observation);
    if (scope != null) reference = { ...reference, executionIdentity: structuredClone(scope) };
    next = {
      ...next,
      gracefulCompletion: reference,
      state:
        reference.responseSettlement !== "pending" &&
        next.state.stage === "live" &&
        next.state.activeResponseId === observation.responseId
          ? { ...next.state, activeResponseId: null }
          : next.state,
    };
  }
  return {
    kind: "conversation_evidence_observed",
    diagnostics: transition?.diagnostics ?? [],
    snapshot: next,
    effects: handoff.effects,
    usageEvidence,
    at,
    notification:
      observation.kind === "provider_finish_interview_observed" &&
      aggregate.state.stage === "live" &&
      next.conversationNodeExecution?.kind !== "retained_output"
        ? "completion"
        : observation.kind === "session_closed_observed" && aggregate.state.stage === "live"
          ? "unable_to_continue"
          : "none",
  };
}

/** Runtime's own observations and the connection's, which are no execution's receipt. */
const runtimeObservationKinds = {
  conversation_evidence_observed: true,
  evidence_prefix_processed: true,
  end_requested: true,
  runtime_failure_observed: true,
  execution_warning_attached: true,
  effect_outcome: true,
  interrupted_effects_recovered: true,
  transcript_digest_computed: true,
  deadline_reached: true,
} as const satisfies Record<
  Exclude<FinalizationObservation["kind"], ProviderFinalizationObservation["kind"]>,
  true
>;

export function isConversationNativeReceipt(
  observation: FinalizationObservation,
): observation is ProviderFinalizationObservation {
  return !Object.hasOwn(runtimeObservationKinds, observation.kind);
}

/** Attach the agent's semantic request to the original receipt's correlated evidence. */
export function interpretConversationTools(
  observation: ProviderFinalizationObservation,
  agent: RuntimeImplementation,
  execution: import("../shared/contracts/runtimeStart.ts").InterviewExecution | null,
  requireReport = false,
  admitReport?: (
    report: import("./executionContracts.ts").SemanticReport<unknown> | undefined,
    responseId: string,
    toolCallId: string,
  ) => boolean | null,
  canInterpret?: (
    invocation: import("./implementationContracts.ts").ConversationToolInvocation,
  ) => boolean,
  outcomes?: Readonly<{
    /** Whether the selected implementation interprets this tool name in any state. */
    known(invocation: import("./implementationContracts.ts").ConversationToolInvocation): boolean;
    /** Receives the outcome of each invocation this receipt interpreted. */
    decide(
      invocation: import("./implementationContracts.ts").ConversationToolInvocation,
      outcome: RuntimeToolCallOutcome,
    ): void;
    /** The target of the transition the admitted report decided, when one was decided. */
    transition(): Readonly<{ target: string | null }> | undefined;
  }>,
): ProviderFinalizationObservation {
  if (!("toolInvocations" in observation)) return observation;
  for (const invocation of observation.toolInvocations ?? []) {
    if (canInterpret?.(invocation) === false) {
      outcomes?.decide(invocation, { outcome: "ignored", reason: "out_of_scope" });
      continue;
    }
    const intent = agent.interpretTool(
      structuredClone(invocation),
      execution === null ? null : structuredClone(execution),
    );
    if (intent === null) {
      outcomes?.decide(
        invocation,
        outcomes.known(invocation)
          ? { outcome: "ignored", reason: "not_accepted" }
          : { outcome: "rejected", reason: "unknown_tool" },
      );
      continue;
    }
    const { callId, responseId, itemId } = invocation;
    const responseStatus:
      | import("./interviewFinalizationModel.ts").ProviderResponseTerminalStatus
      | undefined =
      observation.kind === "reply_generated"
        ? observation.status
        : observation.kind === "reply_cancelled"
          ? "cancelled"
          : undefined;
    const evidence: MutableAgentEndEvidence = {
      generation: observation.generation,
      sequence: observation.sequence,
    };
    if (observation.providerEventId !== undefined)
      evidence.providerEventId = observation.providerEventId;
    if (observation.observedAt !== undefined) evidence.observedAt = observation.observedAt;
    if (itemId !== undefined) evidence.itemId = itemId;
    if (responseStatus !== undefined) evidence.responseStatus = responseStatus;
    if ("usage" in observation && observation.usage !== undefined)
      evidence.usage = observation.usage;
    if ("transcriptItems" in observation && observation.transcriptItems !== undefined)
      evidence.transcriptItems = observation.transcriptItems;
    if (
      "transcriptInventoryComplete" in observation &&
      observation.transcriptInventoryComplete !== undefined
    )
      evidence.transcriptInventoryComplete = observation.transcriptInventoryComplete;
    if (callId === undefined || responseId === undefined) {
      const rejected: MutableAgentEndRejected = {
        ...evidence,
        kind: "provider_finish_interview_rejected",
        missingIdentities: [
          ...(callId === undefined ? ["callId" as const] : []),
          ...(responseId === undefined ? ["responseId" as const] : []),
        ],
      };
      if (callId !== undefined) rejected.callId = callId;
      if (responseId !== undefined) rejected.responseId = responseId;
      outcomes?.decide(invocation, { outcome: "rejected", reason: "undecodable" });
      return rejected;
    }
    if (requireReport) {
      const accepted = admitReport?.(intent.report, responseId, callId);
      if (accepted == null) {
        outcomes?.decide(invocation, { outcome: "ignored", reason: "not_accepted" });
        continue;
      }
      const target = outcomes?.transition()?.target ?? null;
      outcomes?.decide(
        invocation,
        target === null
          ? { outcome: "ignored", reason: "no_transition" }
          : { outcome: "transitioned", to: target },
      );
      if (!accepted) return observation;
    } else outcomes?.decide(invocation, { outcome: "transitioned", to: null });
    return {
      ...evidence,
      kind: "provider_finish_interview_observed",
      callId,
      responseId,
      at: observationAt(observation),
    };
  }
  return observation;
}

type AgentEndEvidence = Omit<
  Extract<ProviderFinalizationObservation, { kind: "provider_finish_interview_observed" }>,
  "kind" | "responseId" | "callId" | "at"
>;
type AgentEndRejected = Extract<
  ProviderFinalizationObservation,
  { kind: "provider_finish_interview_rejected" }
>;

type MutableAgentEndEvidence = { -readonly [Key in keyof AgentEndEvidence]: AgentEndEvidence[Key] };
type MutableAgentEndRejected = { -readonly [Key in keyof AgentEndRejected]: AgentEndRejected[Key] };
