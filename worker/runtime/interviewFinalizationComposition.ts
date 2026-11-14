import { type ResultWarning, type RuntimeWarning } from "../shared/runtimeControllerCallback.ts";
import {
  type InterviewFinalizationStage,
  type InterviewFinalizationState,
  type FinalizationEffectKind,
  type FinalizationEffectRecord,
  type FinalizationInput,
  type FinalizationObservation,
  type RuntimePublicEventPayloads,
  type RuntimePublicEventType,
  type RuntimePublicEventOfType,
  type RuntimePublicEvent,
  type InterviewFinalizationAggregate,
  type FinalizationDecision,
} from "./interviewFinalizationModel.ts";
import { type ActiveFinalizationState } from "./conversationObserve.ts";

export type FinalizationObservationKind = FinalizationInput["kind"];

export type FinalizationAggregateAtStage<Stage extends InterviewFinalizationStage> =
  InterviewFinalizationAggregate &
    Readonly<{
      state: Extract<InterviewFinalizationState, { stage: Stage }>;
    }>;

export type FinalizationObservationOfKind<Kind extends FinalizationObservationKind> = Extract<
  FinalizationInput,
  { kind: Kind }
>;

export function observationAt(observation: FinalizationObservation): number {
  if ("observedAt" in observation && typeof observation.observedAt === "number") {
    return observation.observedAt;
  }
  return "at" in observation && typeof observation.at === "number" ? observation.at : Date.now();
}

export function withEffects(
  aggregate: InterviewFinalizationAggregate,
  effects: readonly FinalizationEffectRecord[],
  events: readonly RuntimePublicEvent[],
): FinalizationDecision {
  if (effects.length === 0 && events.length === 0) return { aggregate, effects: [], events: [] };
  const existing = aggregate.state.effects;
  const nextEffects = [...existing, ...effects];
  return {
    aggregate: {
      ...aggregate,
      nextEffectSequence: aggregate.nextEffectSequence + effects.length,
      nextEventSequence: aggregate.nextEventSequence + events.length,
      state: replaceFinalizationStateEffects(aggregate.state, nextEffects),
    },
    effects,
    events,
  };
}

export function replaceFinalizationStateEffects(
  state: InterviewFinalizationState,
  effects: readonly FinalizationEffectRecord[],
): InterviewFinalizationState {
  return { ...state, effects };
}

/**
 * The record an effect intent creates, with the target its kind requires. The input closure is
 * created only with its obligation (`closeConversationInput`).
 */
export type FinalizationEffectIntent =
  | Readonly<{ kind: "cancel_reply"; responseId: string }>
  | Readonly<{ kind: "compute_transcript_digest"; revision: number }>
  | Readonly<{
      kind: Exclude<
        FinalizationEffectKind,
        "cancel_reply" | "compute_transcript_digest" | "close_input"
      >;
    }>;

function hasSameIntent(
  effect: FinalizationEffectRecord,
  intent: FinalizationEffectIntent,
): boolean {
  if (intent.kind === "cancel_reply")
    return effect.kind === "cancel_reply" && effect.responseId === intent.responseId;
  if (intent.kind === "compute_transcript_digest")
    return effect.kind === "compute_transcript_digest" && effect.revision === intent.revision;
  return effect.kind === intent.kind;
}

export function addEffect(
  aggregate: InterviewFinalizationAggregate,
  effects: FinalizationEffectRecord[],
  intent: FinalizationEffectIntent,
): void {
  if (
    aggregate.state.effects.some((effect) => hasSameIntent(effect, intent)) ||
    effects.some((effect) => hasSameIntent(effect, intent))
  )
    return;
  const id = `${aggregate.runId}:${aggregate.nextEffectSequence + effects.length}`;
  const status = "pending";
  const acceptance = "unobserved";
  effects.push(
    intent.kind === "cancel_reply"
      ? {
          id,
          kind: intent.kind,
          status,
          acceptance,
          attemptCount: 0,
          responseId: intent.responseId,
        }
      : intent.kind === "compute_transcript_digest"
        ? { id, kind: intent.kind, status, acceptance, attemptCount: 0, revision: intent.revision }
        : { id, kind: intent.kind, status, acceptance, attemptCount: 0 },
  );
}

export function addEvent<Type extends RuntimePublicEventType>(
  aggregate: InterviewFinalizationAggregate,
  type: Type,
  payload: RuntimePublicEventPayloads[Type],
): RuntimePublicEventOfType<Type> {
  return { id: allocateEventId(aggregate), type, payload };
}

export function allocateEventId(aggregate: InterviewFinalizationAggregate): string {
  return `${aggregate.runId}:event:${aggregate.nextEventSequence}`;
}

/** Adds one of Runtime's own warnings, from its fixed list `runtimeWarnings`, to Ending's. */
export function withEndingWarning(
  state: ActiveFinalizationState,
  warning: RuntimeWarning,
): ActiveFinalizationState {
  return withResultWarning(state, warning);
}

/** Adds a warning to Ending's once: Runtime's own, or one the Run's combination declares. */
export function withResultWarning(
  state: ActiveFinalizationState,
  warning: ResultWarning,
): ActiveFinalizationState {
  return {
    ...state,
    warnings: state.warnings.includes(warning) ? [...state.warnings] : [...state.warnings, warning],
  };
}

/** Adds one of Runtime's own warnings, from its fixed list `runtimeWarnings`, once. */
export function addWarning(warnings: ResultWarning[], warning: RuntimeWarning): ResultWarning[] {
  if (!warnings.includes(warning)) warnings.push(warning);
  return warnings;
}

/**
 * One durable obligation follows the eligible input across participation and settlement, served
 * by one `close_input` step that carries the answer Runtime already holds, if any.
 */
export function closeConversationInput(
  aggregate: InterviewFinalizationAggregate,
  at: number,
): InterviewFinalizationAggregate {
  if (aggregate.finalInput !== null || aggregate.state.stage !== "live") return aggregate;
  const itemId = aggregate.state.activeInputItemId;
  const effectId = `${aggregate.runId}:${aggregate.nextEffectSequence}`;
  const pending = {
    admissionCutoffAt: at,
    fence: {
      generation: aggregate.providerGeneration,
      sequence: Math.max(0, aggregate.nextProviderSequence - 1),
    },
    effectId,
    inputToSettle: false,
    answerFollows: false,
    settledByTerminalObservation: false,
    quietDeadline: at + 1_000,
    duplicateCount: 0,
    warning: null,
  };
  return {
    ...aggregate,
    nextEffectSequence: aggregate.nextEffectSequence + 1,
    finalInput:
      itemId === null
        ? { ...pending, obligation: "awaiting_item", admittedItemId: null }
        : { ...pending, obligation: "awaiting_transcription", admittedItemId: itemId },
    state: {
      ...aggregate.state,
      effects: [
        ...aggregate.state.effects,
        {
          id: effectId,
          kind: "close_input",
          status: "pending",
          acceptance: "unobserved",
          attemptCount: 0,
          heldItemId: itemId,
        },
      ],
    },
  };
}
