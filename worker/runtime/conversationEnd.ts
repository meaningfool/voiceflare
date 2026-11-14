import {
  drainCheckpointAt,
  interruptedProof,
  isFinishingNode,
  nodeLimitation,
  speakingResponseId,
  type FinalizationEffectKind,
  type FinalizationEffectRecord,
  type InterviewFinalizationAggregate,
  type FinalizationEffectOutcome,
  type FinalizationEffectStatus,
  type FinalizationClosingProviderState,
  type FinalizationFinalizingState,
  type InterviewFinalizationState,
  type RuntimePublicEvent,
  type FinalizationDecision,
  type GracefulCompletionState,
  type FinalizationDrainingState,
  type InputClosureSettlement,
} from "./interviewFinalizationModel.ts";
import { type InterviewRuntimeControllerWork } from "./interviewFinalizationArbitration.ts";
import { permitsFinalizationEffectExecution } from "./interviewFinalizationEffectPolicy.ts";
import { type RuntimeEndReason, type ResultWarning } from "../shared/runtimeControllerCallback.ts";
import { type EndingOperation } from "./nativeContracts.ts";
import {
  type FinalizationAggregateAtStage,
  type FinalizationObservationOfKind,
  withEffects,
  closeConversationInput,
  addEffect,
  addEvent,
  withEndingWarning,
  addWarning,
} from "./interviewFinalizationComposition.ts";
import {
  settleFinalInputAtQuiet,
  settleFinalInputAtDrain,
  deferFinalInputQuietDeadlineToDrain,
  settleSocketContainmentEffectsForClosedSession,
  hasPendingResultObligation,
  shouldWarnForGracefulDelivery,
  earliestProviderCloseBarrier,
  reconcileProviderClosureWarnings,
} from "./conversationObserve.ts";

export type ConversationEndRequest = Readonly<{
  reason: RuntimeEndReason;
  source: string;
  acceptedAt: number;
  cutoffAt: number;
  completionReference: GracefulCompletionState | null;
}>;

export function endConversation(
  aggregate: InterviewFinalizationAggregate,
  request: ConversationEndRequest,
): FinalizationDecision {
  const observation = { reason: request.reason, source: request.source, at: request.acceptedAt };
  let next = { ...aggregate, gracefulCompletion: request.completionReference };
  const effects: FinalizationEffectRecord[] = [];
  const events: RuntimePublicEvent[] = [];

  if (next.state.stage === "ended") {
    return { aggregate: next, effects, events };
  }

  if (next.state.stage !== "live") {
    if (observation.reason === "runtime_failed" && next.state.endReason !== "runtime_failed") {
      next = {
        ...next,
        state: withEndingWarning(next.state, "runtime_failed_during_finalization"),
      };
    }
    return { aggregate: next, effects, events };
  }

  if (
    observation.reason === "agent_requested_end" &&
    next.gracefulCompletion === null &&
    !isFinishingNode(next.conversationNodeExecution) &&
    next.conversationNodeExecution?.dispatch?.status !== "complete"
  ) {
    return { aggregate: next, effects, events };
  }

  const initialEffects = next.state.effects;
  const initialSequence = next.nextEffectSequence;
  next = closeConversationInput(next, request.acceptedAt);
  effects.push(...next.state.effects.slice(initialEffects.length));
  next = {
    ...next,
    nextEffectSequence: initialSequence,
    state: { ...next.state, effects: initialEffects },
  };
  if (next.state.stage !== "live") return { aggregate: next, effects: [], events: [] };
  const liveState = next.state;
  const retainsCurrentTurn =
    observation.reason === "participant_stopped" ||
    observation.reason === "timebox_reached" ||
    observation.reason === "agent_requested_end";
  const retainedResponseId = retainsCurrentTurn
    ? (next.retainedInterviewerResponseId ??
      request.completionReference?.responseId ??
      speakingResponseId(next, liveState))
    : undefined;
  if (retainedResponseId !== undefined && retainedResponseId !== null) {
    next = { ...next, retainedInterviewerResponseId: retainedResponseId };
  }
  if (
    observation.reason === "runtime_failed" ||
    observation.reason === "participant_disconnected" ||
    observation.reason === "participant_stopped" ||
    observation.reason === "timebox_reached"
  ) {
    const proof =
      observation.reason === "runtime_failed" || observation.reason === "participant_disconnected"
        ? interruptedProof(next.applicationTranscriptProof)
        : next.applicationTranscriptProof;
    next = {
      ...next,
      applicationTranscriptProof: {
        ...proof,
        closeBarrier:
          observation.reason === "runtime_failed"
            ? (proof.closeBarrier ??
              next.acceptedProviderOrder ?? { generation: next.providerGeneration, sequence: 0 })
            : proof.closeBarrier,
        obligations: proof.obligations.filter(
          (item) =>
            item.role === "participant" ||
            (retainedResponseId !== undefined &&
              retainedResponseId !== null &&
              next.transcriptCapture.items.some(
                (captured) =>
                  captured.itemId === item.itemId && captured.responseId === retainedResponseId,
              )) ||
            item.status === "captured" ||
            item.status === "failed" ||
            item.status === "non_transcript",
        ),
      },
    };
  }
  if (
    (observation.reason === "participant_stopped" ||
      observation.reason === "timebox_reached" ||
      observation.reason === "agent_requested_end") &&
    !next.applicationTranscriptProof.interrupted
  )
    next = {
      ...next,
      applicationTranscriptProof: {
        ...next.applicationTranscriptProof,
        completedReason: observation.reason,
      },
    };
  const finalInput = next.finalInput;
  if (finalInput === null) throw new Error("conversation_input_closure_missing");
  const drainingBase = {
    stage: "draining",
    endReason: observation.reason,
    source: observation.source,
    strategy: "hard_stop",
    endingStartedAt: observation.at,
    finalizationCutoffAt: request.cutoffAt,
    activeInputItemId:
      finalInput.obligation === "awaiting_transcription"
        ? finalInput.admittedItemId
        : liveState.activeInputItemId,
    admittedResponseId: next.retainedInterviewerResponseId ?? liveState.activeResponseId,
    activeResponseId: liveState.activeResponseId,
    outputAudioActive: liveState.outputAudioActive,
    sessionClosed: liveState.sessionClosed,
  } satisfies Omit<FinalizationDrainingState, "providerCloseBarrier" | "effects" | "warnings">;
  const draining =
    liveState.providerCloseBarrier === undefined
      ? ({
          ...drainingBase,
          effects: liveState.effects,
          warnings: [],
        } satisfies FinalizationDrainingState)
      : ({
          ...drainingBase,
          providerCloseBarrier: liveState.providerCloseBarrier,
          effects: liveState.effects,
          warnings: [],
        } satisfies FinalizationDrainingState);
  const limitation = nodeLimitation(next.conversationNodeExecution);
  const retainsOutput = next.conversationNodeExecution?.kind === "retained_output";
  const closingWarning =
    limitation === undefined || retainsOutput
      ? null
      : limitation === "closing_cutoff_exhausted" ||
          limitation === "closing_recovery_uncertain" ||
          limitation === "closing_interrupted"
        ? limitation
        : "closing_response_failed";
  const outputWarnings =
    retainsOutput && shouldWarnForGracefulDelivery(next)
      ? addWarning([...draining.warnings], "agent_output_not_fully_delivered")
      : draining.warnings;
  const warnings = (next.executionWarnings ?? []).reduce(
    (joined: readonly ResultWarning[], warning) =>
      joined.includes(warning) ? joined : [...joined, warning],
    closingWarning === null ? outputWarnings : addWarning([...outputWarnings], closingWarning),
  );
  next = {
    ...next,
    state: warnings === draining.warnings ? draining : { ...draining, warnings },
    finalInput,
  };
  for (const response of next.providerResponses)
    if (response.status === "active" || response.outputAudio === "active")
      addEffect(next, effects, { kind: "cancel_reply", responseId: response.responseId });
  addEffect(next, effects, { kind: "stop_output" });
  addEffect(next, effects, { kind: "arm_alarm" });
  events.push(
    addEvent(next, "runtime.ending", {
      endReason: observation.reason,
      source: observation.source,
      strategy: draining.strategy,
      finalizationCutoffAt: draining.finalizationCutoffAt,
      drainDeadline: drainCheckpointAt(draining),
    }),
  );
  return withEffects(next, effects, events);
}

export type ConversationEndingLifecycle = Readonly<{
  freeze: (
    aggregate: InterviewFinalizationAggregate,
    effects: FinalizationEffectRecord[],
    events: RuntimePublicEvent[],
    at: number,
  ) => FinalizationDecision;
  reconcile: (
    aggregate: InterviewFinalizationAggregate,
    effects: FinalizationEffectRecord[],
    events: RuntimePublicEvent[],
    at?: number,
  ) => FinalizationDecision;
}>;

export function advanceConversationClosingProviderDeadlineObservation(
  aggregate: FinalizationAggregateAtStage<"closing_provider">,
  observation: FinalizationObservationOfKind<"deadline_reached">,
  lifecycle: ConversationEndingLifecycle,
): FinalizationDecision {
  if (observation.deadline === "timebox" || observation.deadline === "presence_grace") {
    return { aggregate, effects: [], events: [] };
  }
  const effects: FinalizationEffectRecord[] = [];
  const events: RuntimePublicEvent[] = [];
  if (observation.deadline !== "finalization_cutoff") {
    return { aggregate, effects, events };
  }
  if (observation.at < aggregate.state.finalizationCutoffAt) {
    return { aggregate, effects, events };
  }

  const boundedAtCutoff = settleFinalInputAtDrain(aggregate);
  if (boundedAtCutoff.state.stage !== "closing_provider") {
    return { aggregate: boundedAtCutoff, effects, events };
  }
  const warnings = [...boundedAtCutoff.state.warnings];
  if (!boundedAtCutoff.state.sessionClosed) {
    addWarning(warnings, "session_close_unconfirmed");
  }
  const bounded = {
    ...boundedAtCutoff,
    state: { ...boundedAtCutoff.state, warnings },
  };
  return lifecycle.freeze(bounded, effects, events, observation.at);
}

export function advanceConversationDrainingDeadlineObservation(
  aggregate: FinalizationAggregateAtStage<"draining">,
  observation: FinalizationObservationOfKind<"deadline_reached">,
  lifecycle: ConversationEndingLifecycle,
): FinalizationDecision {
  if (observation.deadline === "timebox" || observation.deadline === "presence_grace") {
    return { aggregate, effects: [], events: [] };
  }
  const effects: FinalizationEffectRecord[] = [];
  const events: RuntimePublicEvent[] = [];
  if (observation.deadline === "drain") {
    return applyDrainCheckpointObservation(aggregate, observation, lifecycle);
  }
  if (observation.deadline !== "finalization_cutoff") {
    return { aggregate, effects, events };
  }

  const initialDrainingState = aggregate.state;
  if (observation.at < initialDrainingState.finalizationCutoffAt) {
    return { aggregate, effects, events };
  }

  let next = settleFinalInputAtDrain(aggregate);
  if (next.state.stage !== "draining") return { aggregate: next, effects, events };
  const drainingState = next.state;
  const warnings = [...drainingState.warnings];
  if (hasPendingResultObligation(next)) addWarning(warnings, "drain_timed_out");
  if (
    drainingState.activeInputItemId !== null ||
    next.finalInput?.warning === "final_input_may_be_incomplete"
  ) {
    addWarning(warnings, "final_input_may_be_incomplete");
  }
  next = { ...next, state: { ...drainingState, warnings } };
  addEffect(next, effects, { kind: "release_session" });
  return lifecycle.freeze(next, effects, events, observation.at);
}

/**
 * The nine-second drain checkpoint: settle quiet final input early, otherwise begin provider
 * cleanup. It never settles evidence obligations or becomes a second result deadline.
 */ function applyDrainCheckpointObservation(
  aggregate: FinalizationAggregateAtStage<"draining">,
  observation: FinalizationObservationOfKind<"deadline_reached">,
  lifecycle: ConversationEndingLifecycle,
): FinalizationDecision {
  const effects: FinalizationEffectRecord[] = [];
  const events: RuntimePublicEvent[] = [];
  const initialDrainingState = aggregate.state;
  let next: InterviewFinalizationAggregate = aggregate;
  const quietSettled = settleFinalInputAtQuiet(next, observation.at);
  const finalInputQuietReached =
    next.finalInput?.obligation === "settled" && observation.at >= next.finalInput.quietDeadline;
  if (observation.at >= initialDrainingState.finalizationCutoffAt) {
    return advanceConversationDrainingDeadlineObservation(
      aggregate,
      {
        kind: "deadline_reached",
        deadline: "finalization_cutoff",
        at: observation.at,
      },
      lifecycle,
    );
  }
  if (
    (quietSettled !== next || finalInputQuietReached) &&
    !hasPendingResultObligation(quietSettled)
  ) {
    return lifecycle.reconcile(quietSettled, effects, events, observation.at);
  } else if (observation.at < drainCheckpointAt(initialDrainingState)) {
    return {
      aggregate: deferFinalInputQuietDeadlineToDrain(quietSettled, observation.at),
      effects,
      events,
    };
  }
  // Nine seconds is only a containment checkpoint. It may start provider cleanup,
  // but it cannot settle evidence obligations or become a second result deadline.
  next = quietSettled;
  if (next.state.stage !== "draining") return { aggregate: next, effects, events };
  const drainingState = next.state;
  const closing: FinalizationClosingProviderState = {
    ...drainingState,
    stage: "closing_provider",
  };
  next = { ...next, state: closing };
  for (const response of next.providerResponses) {
    if (response.status === "active")
      addEffect(next, effects, { kind: "cancel_reply", responseId: response.responseId });
  }
  addEffect(next, effects, { kind: "discard_later_input" });
  addEffect(next, effects, { kind: "stop_output" });
  addEffect(next, effects, { kind: "release_session" });
  addEffect(next, effects, { kind: "arm_alarm" });
  const decision = withEffects(next, effects, events);
  return hasPendingResultObligation(decision.aggregate)
    ? decision
    : lifecycle.reconcile(decision.aggregate, [], events, observation.at);
}

export function advanceConversationEffectOutcomeObservation(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"effect_outcome">,
  lifecycle: ConversationEndingLifecycle,
): FinalizationDecision {
  const pendingEffect = aggregate.state.effects.find(
    (effect) => effect.id === observation.effectId,
  );
  if (
    pendingEffect === undefined ||
    (pendingEffect.status !== "pending" && pendingEffect.status !== "sending")
  ) {
    return { aggregate, effects: [], events: [] };
  }

  let next = { ...aggregate };
  let state = updateEffectOutcome(next.state, observation.effectId, observation.outcome);
  const settledEffect = state.effects.find((effect) => effect.id === observation.effectId);
  if (
    state.stage === "closing_provider" &&
    settledEffect?.kind === "release_session" &&
    observation.outcome.status === "dispatched" &&
    observation.outcome.code === "session_closed"
  ) {
    const providerCloseBarrier = earliestProviderCloseBarrier(
      state.providerCloseBarrier,
      observation.providerCloseBarrier,
    );
    const containedState = settleSocketContainmentEffectsForClosedSession(state);
    state =
      providerCloseBarrier === undefined
        ? { ...containedState, sessionClosed: true }
        : {
            ...containedState,
            sessionClosed: true,
            providerCloseBarrier: {
              generation: providerCloseBarrier.generation,
              sequence: providerCloseBarrier.sequence,
            },
          };
  }
  if (state !== next.state) {
    next = { ...next, state };
  }
  if (
    next.finalInput !== null &&
    observation.effectId === next.finalInput.effectId &&
    observation.outcome.settlement !== undefined
  )
    next = applyInputClosureSettlement(next, observation.outcome.settlement);
  if (
    next.finalInput !== null &&
    observation.effectId === next.finalInput.effectId &&
    observation.outcome.status === "benign_rejection"
  ) {
    next = {
      ...next,
      finalInput: {
        ...next.finalInput,
        obligation: "settled",
        quietDeadline: next.finalInput.quietDeadline,
      },
    };
  }
  return lifecycle.reconcile(next, [], [], observation.at);
}

export function updateEffectOutcome(
  state: InterviewFinalizationState,
  effectId: string,
  outcome: FinalizationEffectOutcome,
): InterviewFinalizationState {
  if (state.stage === "ended") return state;
  const effects = state.effects.map((effect): FinalizationEffectRecord => {
    if (effect.id !== effectId) return effect;
    const status: FinalizationEffectStatus =
      effect.kind === "compute_transcript_digest" && outcome.status === "dispatched"
        ? "pending"
        : outcome.status === "benign_rejection"
          ? "dispatched"
          : outcome.status;
    return {
      ...effect,
      status,
      acceptance:
        outcome.acceptance ??
        (outcome.status === "benign_rejection" ? "benign_rejection" : effect.acceptance),
      attemptCount: effect.attemptCount + 1,
    };
  });
  if (effects.every((effect, index) => effect === state.effects[index])) return state;
  const warnings = state.stage === "live" ? [] : [...state.warnings];
  const effect = effects.find((candidate) => candidate.id === effectId);
  if (
    effect !== undefined &&
    outcome.status !== "dispatched" &&
    outcome.status !== "benign_rejection"
  ) {
    if (effect.kind === "release_session") {
      addWarning(
        warnings,
        outcome.status === "uncertain" ? "session_release_uncertain" : "session_release_failed",
      );
      if (outcome.timedOut === true) addWarning(warnings, "session_release_timed_out");
    }
    if (
      effect.kind === "close_input" &&
      (effect.heldItemId === null || outcome.settlement?.supersedesHeld === true) &&
      outcome.status === "uncertain" &&
      (state.stage === "live" ||
        ((state.stage === "draining" || state.stage === "closing_provider") &&
          state.activeInputItemId !== null) ||
        outcome.settlement?.inputToSettle === true)
    ) {
      addWarning(warnings, "final_input_may_be_incomplete");
    }
  }
  if (state.stage === "live") return { ...state, effects };
  return { ...state, effects, warnings };
}

/**
 * The execution's account of how it carries out the input closure. When the answer Runtime held
 * is not the last one, Runtime awaits the later answer instead, as if it had held none.
 */
export function applyInputClosureSettlement(
  aggregate: InterviewFinalizationAggregate,
  settlement: InputClosureSettlement,
): InterviewFinalizationAggregate {
  const finalInput = aggregate.finalInput;
  if (finalInput === null) return aggregate;
  const superseded = settlement.supersedesHeld && finalInput.admittedItemId !== null;
  const state = aggregate.state;
  return {
    ...aggregate,
    state:
      superseded &&
      (state.stage === "live" ||
        state.stage === "draining" ||
        state.stage === "closing_provider") &&
      state.activeInputItemId === finalInput.admittedItemId
        ? { ...state, activeInputItemId: null }
        : state,
    finalInput: superseded
      ? {
          ...finalInput,
          obligation: "awaiting_item",
          admittedItemId: null,
          answerFollows: settlement.answerFollows,
          inputToSettle: settlement.inputToSettle,
        }
      : {
          ...finalInput,
          answerFollows: settlement.answerFollows,
          inputToSettle: settlement.inputToSettle,
        },
  };
}

export function toFinalizingState(
  state: FinalizationClosingProviderState,
): FinalizationFinalizingState {
  return {
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
    warnings: state.sessionClosed
      ? reconcileProviderClosureWarnings(state.warnings, state.activeInputItemId !== null)
      : state.warnings,
  };
}

export function applyEndedEffectOutcomeObservation(
  aggregate: FinalizationAggregateAtStage<"ended">,
  observation: FinalizationObservationOfKind<"effect_outcome">,
): FinalizationDecision {
  const effect = aggregate.state.effects.find(({ id }) => id === observation.effectId);
  if (
    effect?.kind !== "release_session" ||
    (effect.status !== "pending" && effect.status !== "sending")
  ) {
    return { aggregate, effects: [], events: [] };
  }
  const status =
    observation.outcome.status === "benign_rejection" ? "dispatched" : observation.outcome.status;
  const effects = aggregate.state.effects.map((candidate) =>
    candidate.id === observation.effectId
      ? {
          ...candidate,
          status,
          acceptance:
            observation.outcome.acceptance ??
            (observation.outcome.status === "benign_rejection"
              ? ("benign_rejection" as const)
              : candidate.acceptance),
          attemptCount: candidate.attemptCount + 1,
        }
      : candidate,
  );
  return {
    aggregate: { ...aggregate, state: { ...aggregate.state, effects } },
    effects: [],
    events: [],
  };
}

export function applyEndedInterruptedEffectsRecovered(
  aggregate: FinalizationAggregateAtStage<"ended">,
  _observation: FinalizationObservationOfKind<"interrupted_effects_recovered">,
): FinalizationDecision {
  const effects = aggregate.state.effects.map((effect) =>
    effect.kind === "release_session" && effect.status === "sending"
      ? { ...effect, status: "uncertain" as const, attemptCount: effect.attemptCount + 1 }
      : effect,
  );
  return effects.every((effect, index) => effect === aggregate.state.effects[index])
    ? { aggregate, effects: [], events: [] }
    : {
        aggregate: { ...aggregate, state: { ...aggregate.state, effects } },
        effects: [],
        events: [],
      };
}

export function containEffectAtResultFreeze(
  effect: FinalizationEffectRecord,
): FinalizationEffectRecord {
  if (effect.kind === "compute_transcript_digest" || effect.kind === "release_session") {
    return effect;
  }
  if (effect.status === "sending") return { ...effect, status: "uncertain" };
  if (effect.status === "pending") return { ...effect, status: "failed" };
  return effect;
}

export function requestConversationCleanup(
  aggregate: InterviewFinalizationAggregate,
  effects: FinalizationEffectRecord[],
): void {
  addEffect(aggregate, effects, { kind: "release_session" });
}

export function selectEndingOperation(effect: FinalizationEffectRecord): EndingOperation {
  if (effect.kind === "cancel_reply")
    return { kind: effect.kind, commandId: effect.id, responseId: effect.responseId };
  if (effect.kind === "close_input")
    return { kind: effect.kind, commandId: effect.id, heldItemId: effect.heldItemId };
  if (effect.kind === "discard_later_input" || effect.kind === "stop_output")
    return { kind: effect.kind, commandId: effect.id };
  throw new Error(`invalid_finalization_effect:${effect.kind}`);
}

export function projectEffects(
  aggregate: InterviewFinalizationAggregate,
): readonly InterviewFinalizationExecutableEffect[] {
  const node = aggregate.conversationNodeExecution;
  const cleanupEffectId =
    node?.kind === "retained_output" && node.cleanup.status === "claimed"
      ? node.cleanup.effectId
      : undefined;
  return aggregate.state.effects.flatMap((effect, order) => {
    if (
      (aggregate.state.stage === "live" &&
        node?.kind === "finishing" &&
        effect.kind === "close_input") ||
      effect.status !== "pending" ||
      (isProviderCommandEffect(effect) && effect.attemptCount !== 0) ||
      !permitsFinalizationEffectExecution(aggregate.state.stage, effect.kind) ||
      ((aggregate.state.stage === "live" || aggregate.state.stage === "draining") &&
        effect.kind === "release_session" &&
        cleanupEffectId !== effect.id)
    )
      return [];
    return [
      {
        effect,
        requirement: effectRequirement(effect),
        work: { id: `effect:${effect.id}`, kind: "provider_effect", order },
      },
    ];
  });
}

export function isProviderCommandEffect(effect: FinalizationEffectRecord): boolean {
  return effect.kind !== "compute_transcript_digest" && effect.kind !== "arm_alarm";
}

export function effectRequirement(
  effect: FinalizationEffectRecord,
): FinalizationEffectExecutionRequirement {
  switch (effect.kind) {
    case "compute_transcript_digest":
    case "arm_alarm":
      return "provider_free";
    case "release_session":
      return "session_identity";
    case "close_input":
    case "discard_later_input":
    case "cancel_reply":
    case "stop_output":
      return "connected_session";
    default:
      return assertUnreachable(effect);
  }
}

export function projectProviderConnection(
  aggregate: InterviewFinalizationAggregate,
  facts: InterviewFinalizationExecutionFacts,
  effects: readonly InterviewFinalizationExecutableEffect[],
): InterviewFinalizationProviderConnectionDemand {
  const state = aggregate.state;
  let untilAt: number | null;
  switch (state.stage) {
    case "live":
      untilAt =
        facts.liveDeadlineAt === null
          ? facts.participantPresenceDeadlineAt
          : facts.participantPresenceDeadlineAt === null
            ? facts.liveDeadlineAt
            : Math.min(facts.liveDeadlineAt, facts.participantPresenceDeadlineAt);
      break;
    case "draining":
      untilAt = drainCheckpointAt(state);
      break;
    case "closing_provider":
      untilAt = state.finalizationCutoffAt;
      break;
    case "finalizing":
    case "ended":
      untilAt = null;
      break;
    default:
      return assertUnreachable(state);
  }

  if (
    ("sessionClosed" in state && state.sessionClosed) ||
    untilAt === null ||
    untilAt <= facts.now
  ) {
    return { required: false, untilAt, reasons: [] };
  }

  const hasSocketEffect = effects.some(({ requirement }) => requirement === "connected_session");
  // Finalization never creates session demand. A socket that is already
  // connected can carry its one command attempt, but loss is not repaired for
  // evidence or cleanup. Hangup uses the HTTP call identity directly.
  if (state.stage !== "live") {
    return { required: false, untilAt, reasons: [] };
  }
  return {
    required: true,
    untilAt,
    reasons: ["provider_observation", ...(hasSocketEffect ? (["session_effect"] as const) : [])],
  };
}

function assertUnreachable(value: never): never {
  throw new Error(`Unsupported Conversation ending value: ${JSON.stringify(value)}`);
}

export type InterviewFinalizationExecutionFacts = Readonly<{
  now: number;
  liveDeadlineAt: number | null;
  participantPresenceDeadlineAt: number | null;
  browserMediaReadyDeadlineAt?: number | null;
  openingPending?: boolean;
}>;

export type FinalizationEffectExecutionRequirement =
  | "provider_free"
  | "connected_session"
  | "session_identity";

export type InterviewFinalizationExecutableEffect = Readonly<{
  effect: FinalizationEffectRecord;
  requirement: FinalizationEffectExecutionRequirement;
  work: InterviewRuntimeControllerWork;
}>;

export type InterviewFinalizationProviderConnectionDemand = Readonly<{
  required: boolean;
  untilAt: number | null;
  reasons: readonly ("provider_observation" | "session_effect")[];
}>;

export type FinalizationEffectRecoveryContract = Readonly<{
  correlation: string;
  retry: string;
  consequence: string;
  benignRejection: string;
  deadline: string;
  terminalWarning: string;
}>;

export const finalizationEffectRecoveryContracts = {
  compute_transcript_digest: {
    correlation: "effect_id_and_transcript_revision",
    retry: "safe_after_interrupted_sending",
    consequence: "matching_digest_persisted",
    benignRejection: "none",
    deadline: "finalization_completion_bound",
    terminalWarning: "none",
  },
  close_input: {
    correlation: "effect_id_and_final_input_fence",
    retry: "never_retry_uncertain_dispatch",
    consequence: "input_closed_and_one_post_fence_item_or_nothing_to_settle",
    benignRejection: "nothing_to_settle_or_held_answer_session_closed",
    deadline: "remaining_finalization_cutoff",
    terminalWarning: "final_input_may_be_incomplete",
  },
  discard_later_input: {
    correlation: "effect_id_and_input_obligation",
    retry: "never_retry_provider_command",
    consequence: "later_input_cleared_or_session_closed",
    benignRejection: "session_closed_observed",
    deadline: "remaining_finalization_cutoff",
    terminalWarning: "post_end_input_leaked",
  },
  cancel_reply: {
    correlation: "effect_id_and_response_id",
    retry: "never_retry_provider_command",
    consequence: "named_response_terminal_or_session_closed",
    benignRejection: "named_response_terminal_or_session_closed",
    deadline: "remaining_finalization_cutoff",
    terminalWarning: "post_end_output_leaked",
  },
  stop_output: {
    correlation: "effect_id_and_output_obligation",
    retry: "never_retry_provider_command",
    consequence: "output_audio_stopped_or_session_closed",
    benignRejection: "output_audio_stopped_or_session_closed",
    deadline: "remaining_finalization_cutoff",
    terminalWarning: "post_end_output_leaked",
  },
  release_session: {
    correlation: "effect_id_and_provider_call_id",
    retry: "never_retry_uncertain_dispatch",
    consequence: "provider_close_event_documented_terminal_evidence_or_absolute_bound",
    benignRejection: "session_closed",
    deadline: "remaining_cutoff_or_retained_first_dispatch",
    terminalWarning: "session_release_failed_timed_out_or_uncertain",
  },
  arm_alarm: {
    correlation: "effect_id_and_persisted_absolute_deadline",
    retry: "safe_after_interrupted_sending",
    consequence: "earliest_absolute_deadline_armed",
    benignRejection: "none",
    deadline: "persisted_absolute_deadline",
    terminalWarning: "none",
  },
} as const satisfies Record<FinalizationEffectKind, FinalizationEffectRecoveryContract>;

export function deferConversationFreezeForReceiptPrefix(
  aggregate: InterviewFinalizationAggregate,
  effects: FinalizationEffectRecord[],
  events: RuntimePublicEvent[],
  at: number,
): FinalizationDecision {
  if (aggregate.state.stage !== "draining") return withEffects(aggregate, effects, events);
  const checkpointAt = drainCheckpointAt(aggregate.state);
  if (at < checkpointAt)
    return withEffects(
      {
        ...aggregate,
        finalInput:
          aggregate.finalInput === null
            ? null
            : { ...aggregate.finalInput, quietDeadline: checkpointAt },
      },
      effects,
      events,
    );
  const closing: FinalizationClosingProviderState = {
    ...aggregate.state,
    stage: "closing_provider",
  };
  const next = { ...aggregate, state: closing };
  for (const response of next.providerResponses)
    if (response.status === "active")
      addEffect(next, effects, { kind: "cancel_reply", responseId: response.responseId });
  addEffect(next, effects, { kind: "discard_later_input" });
  addEffect(next, effects, { kind: "stop_output" });
  requestConversationCleanup(next, effects);
  addEffect(next, effects, { kind: "arm_alarm" });
  return withEffects(next, effects, events);
}
