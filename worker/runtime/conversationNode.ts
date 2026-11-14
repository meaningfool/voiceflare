import { z } from "zod";
import { closeConversationInput } from "./interviewFinalizationComposition.ts";
import { conversationJsonSchema, requireConversationState } from "./conversationContracts.ts";
import type { AcceptedConversation, ConversationCallbackJson } from "./conversationContracts.ts";
import type { ConversationVisit } from "./executionContracts.ts";
import type { RuntimeImplementation } from "./implementationContracts.ts";
import {
  conversationNodeDeadline,
  isFinishingNode,
  speakingResponseId,
  type InterviewFinalizationAggregate,
} from "./interviewFinalizationModel.ts";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1);

const dispatchFields = {
  input: conversationJsonSchema,
  triggeringResponseId: identifier.optional(),
  toolCallId: identifier.optional(),
};

/**
 * The selected input dispatched for the current `conversationVisit`. The visit owns the state,
 * visit and operation identity; only a failed or uncertain dispatch retains a limitation.
 */
const nodeDispatchSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      ...dispatchFields,
      status: z.enum(["pending", "claimed", "dispatched", "complete"]),
    })
    .readonly(),
  z
    .strictObject({
      ...dispatchFields,
      status: z.enum(["failed", "uncertain"]),
      limitation: identifier.optional(),
    })
    .readonly(),
]);

const nodeTimingFields = {
  timers: z
    .array(
      z
        .strictObject({ id: identifier, deadlineAt: timestamp, event: conversationJsonSchema })
        .readonly(),
    )
    .readonly(),
  associatedTimerId: identifier.optional(),
};

/** A finishing node has reserved its ending reason, closed input and fixed its cutoffs. */
const finishingFields = {
  ...nodeTimingFields,
  reservation: z
    .strictObject({
      reason: z.enum(["agent_requested_end", "timebox_reached"]),
      source: z.enum(["agent_completion", "timebox_alarm"]),
      at: timestamp,
      triggeringResponseId: identifier.optional(),
      toolCallId: identifier.optional(),
      /**
       * The reply of the previous visit still being generated or spoken when the interview
       * deadline started this closing. Its text is kept under that visit, as Stop keeps it;
       * nothing that acts from it is admitted.
       */
      cutResponseId: identifier.optional(),
    })
    .readonly(),
  mediaCutoffAt: timestamp,
  closingCutoffAt: timestamp,
  dispatch: nodeDispatchSchema,
  participantEnd: z.strictObject({ at: timestamp, source: identifier }).readonly().optional(),
  /**
   * The node completed normally and Ending waits until its last reply has had time to play:
   * Ending starts at this time, unless Stop, a failure or a lost participant ends it first.
   */
  endingAt: timestamp.optional(),
};

/**
 * Persisted Conversation node execution:
 *
 * - `ordinary`: a visit without a finishing reservation. It may have no dispatch yet (the
 *   initial state is opened by startup) and no business cutoff when it declares no timer.
 * - `finishing`: a state that finishes participation, with its reservation, cutoffs and dispatch.
 * - `retained_output`: Original's finishing state, which retains the finishing output and owns
 *   one bounded cleanup; a claimed cleanup always names its effect.
 *
 * The refinement keeps only facts that cross fields: timer identity, cutoff ordering and the
 * participant End that a failed finishing dispatch can retain.
 */
export const conversationNodeExecutionSchema = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        kind: z.literal("ordinary"),
        ...nodeTimingFields,
        mediaCutoffAt: timestamp.nullable(),
        dispatch: nodeDispatchSchema.optional(),
      })
      .readonly(),
    z.strictObject({ kind: z.literal("finishing"), ...finishingFields }).readonly(),
    z
      .strictObject({
        kind: z.literal("retained_output"),
        ...finishingFields,
        cleanup: z.discriminatedUnion("status", [
          z.strictObject({ status: z.literal("scheduled"), at: timestamp }).readonly(),
          z
            .strictObject({ status: z.literal("claimed"), at: timestamp, effectId: identifier })
            .readonly(),
        ]),
      })
      .readonly(),
  ])
  .superRefine((value, context) => {
    const timerIds = value.timers.map((timer) => timer.id);
    let invalid =
      new Set(timerIds).size !== timerIds.length ||
      (value.associatedTimerId !== undefined && !timerIds.includes(value.associatedTimerId));
    if (value.kind !== "ordinary") {
      const { reservation, dispatch, participantEnd } = value;
      invalid ||=
        (value.endingAt !== undefined && dispatch.status !== "complete") ||
        reservation.at > value.closingCutoffAt ||
        value.closingCutoffAt > value.mediaCutoffAt ||
        (participantEnd !== undefined &&
          (dispatch.status !== "failed" ||
            dispatch.limitation === undefined ||
            participantEnd.at < reservation.at ||
            participantEnd.at >= value.closingCutoffAt));
    }
    if (invalid)
      context.addIssue({ code: "custom", message: "inconsistent_conversation_node_execution" });
  });
export type ConversationNodeExecution = z.output<typeof conversationNodeExecutionSchema>;
export type ConversationNodeDispatchRecord = z.output<typeof nodeDispatchSchema>;
export type FinishingConversationNode = Exclude<ConversationNodeExecution, { kind: "ordinary" }>;

/** Admission records a fresh visit, selected input and dispatch; only finishing closes input. */
export function enterConversationNode(
  aggregate: InterviewFinalizationAggregate,
  implementation: RuntimeImplementation,
  accepted: AcceptedConversation,
  target: string,
  cause: Readonly<{
    reason: "agent_requested_end" | "timebox_reached";
    at: number;
    responseId?: string | undefined;
    toolCallId?: string | undefined;
    context?: ConversationCallbackJson | undefined;
  }>,
): InterviewFinalizationAggregate {
  const current = aggregate.conversationNodeExecution;
  if (isFinishingNode(current) || aggregate.state.stage !== "live") return aggregate;
  const priorMediaCutoffAt = current?.mediaCutoffAt ?? null;
  const plan = accepted.timers?.({
    liveAt: aggregate.applicationTranscriptProof.liveAt,
    enteredAt: cause.at,
    state: target,
  });
  const cutoffAt = conversationNodeDeadline({ timers: plan?.timers ?? [] }) ?? priorMediaCutoffAt;
  const finishesParticipation =
    requireConversationState(implementation.conversation, target)?.finishesParticipation === true;
  const cleanupAt = plan?.retainedOutputCleanupAt;
  if (cleanupAt !== undefined && !finishesParticipation)
    throw new Error("conversation_retained_output_not_finishing");
  let visit: ConversationVisit = {
    state: target,
    visitId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    revision: (aggregate.conversationVisit?.revision ?? 0) + 1,
  };
  // The context, timer events and node input are the selected Conversation's typed outputs
  // (or the stored visit's context); they are recorded without another decode.
  const context = cause.context ?? aggregate.conversationVisit?.context;
  if (context !== undefined) visit = { ...visit, context };
  let timing: Pick<ConversationNodeExecution, "timers" | "associatedTimerId"> = {
    timers: plan?.timers ?? [],
  };
  if (plan?.associatedTimerId !== undefined)
    timing = { ...timing, associatedTimerId: plan.associatedTimerId };
  let dispatch: ConversationNodeDispatchRecord = {
    input: accepted.selectInput(target, { runId: aggregate.runId, context: visit.context }),
    status: cleanupAt === undefined ? "pending" : "dispatched",
  };
  if (cause.responseId !== undefined)
    dispatch = { ...dispatch, triggeringResponseId: cause.responseId };
  if (cause.toolCallId !== undefined) dispatch = { ...dispatch, toolCallId: cause.toolCallId };
  if (!finishesParticipation)
    return {
      ...aggregate,
      conversationVisit: visit,
      conversationNodeExecution: {
        kind: "ordinary",
        ...timing,
        mediaCutoffAt: priorMediaCutoffAt,
        dispatch,
      },
    };
  if (cutoffAt === null) throw new Error("conversation_finishing_deadline_missing");
  let reservation: FinishingConversationNode["reservation"] = {
    reason: cause.reason,
    source: cause.reason === "timebox_reached" ? "timebox_alarm" : "agent_completion",
    at: cause.at,
  };
  if (cause.responseId !== undefined)
    reservation = { ...reservation, triggeringResponseId: cause.responseId };
  if (cause.toolCallId !== undefined)
    reservation = { ...reservation, toolCallId: cause.toolCallId };
  const cutResponseId =
    cause.reason === "timebox_reached" ? speakingResponseId(aggregate, aggregate.state) : undefined;
  if (cutResponseId !== undefined) reservation = { ...reservation, cutResponseId };
  const finishing = {
    ...timing,
    reservation,
    mediaCutoffAt: Math.max(priorMediaCutoffAt ?? cutoffAt, cutoffAt),
    closingCutoffAt: cutoffAt,
    dispatch,
  };
  return closeConversationInput(
    {
      ...aggregate,
      conversationVisit: visit,
      conversationNodeExecution:
        cleanupAt === undefined
          ? { kind: "finishing", ...finishing }
          : {
              kind: "retained_output",
              ...finishing,
              cleanup: { status: "scheduled", at: cleanupAt },
            },
    },
    cause.at,
  );
}

/** Transcript inventory is independent of whether native audio finished successfully. */
export function hasCompleteNodeTranscriptInventory(
  visit: Pick<ConversationVisit, "visitId" | "operationId"> | undefined,
  responses: InterviewFinalizationAggregate["providerResponses"],
  inventoriedResponseIds: readonly string[] | undefined,
): boolean {
  if (visit === undefined) return false;
  const owned = responses.filter(
    (response) =>
      response.conversationScope?.operationId === visit.operationId &&
      response.conversationScope.visitId === visit.visitId,
  );
  return (
    owned.length > 0 &&
    owned.every((response) => inventoriedResponseIds?.includes(response.responseId) === true)
  );
}
