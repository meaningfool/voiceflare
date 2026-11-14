import { z } from "zod";
import { describeDiagnostic } from "../runtime/diagnosticContracts.ts";
import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  declareConversation,
  declareStateContent,
  reportToolCall,
  type ConversationState,
} from "../runtime/conversationContracts.ts";
import type { DiagnosticDescription } from "../runtime/diagnosticContracts.ts";
import type { StateReporter } from "../runtime/executionContracts.ts";
import type {
  ConversationToolIntent,
  ConversationToolInvocation,
  PreparedClosing,
  PreparedConversationNode,
} from "../runtime/nodeContentContracts.ts";
/** This Conversation's identity, as the registry, Lab and the voice suite name it. */
export const goodbyeInterviewIdentity = Object.freeze({ id: "goodbye-interview", version: 1 });
const text = z.string().refine((value) => value.trim().length > 0);
const interviewingInputSchema = z.strictObject({
  instructions: z.strictObject({ kind: z.literal("literal"), text }),
  toolDescriptions: z.strictObject({ finish_interview: text }),
});
/** Goodbye's input: the sentence the interviewer says to close, which no model generates. */
const goodbyeInputSchema = z.strictObject({ closingSentence: text });
export const goodbyeInterviewInputSchema = z.strictObject({
  contract: z.literal("goodbye-interview-input/v1"),
  interviewingDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maximumClosingDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  interviewing: interviewingInputSchema,
  goodbye: goodbyeInputSchema,
});
export type GoodbyeInterviewInput = z.output<typeof goodbyeInterviewInputSchema>;
export const decodeGoodbyeInterviewInput = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    goodbyeInterviewInputSchema,
  ),
  convert: (value) => value,
});
export const goodbyeInterviewingEventSchema = z.strictObject({
  kind: z.literal("finish_intent"),
  responseId: text,
  toolCallId: text,
});
export const goodbyeRuntimeEventSchema = z.strictObject({
  kind: z.enum(["interview_time_elapsed", "closing_time_elapsed", "participant_stopped"]),
});
export const goodbyeCompletedEventSchema = z.strictObject({
  kind: z.literal("goodbye_completed"),
  responseId: text,
});
export type GoodbyeInterviewingEvent = z.output<typeof goodbyeInterviewingEventSchema>;
export const goodbyeInterviewStates = Object.freeze({
  interviewing: Object.freeze({
    id: "goodbye-interview/1/interviewing",
    input: interviewingInputSchema,
    event: goodbyeInterviewingEventSchema,
  } satisfies ConversationState<GoodbyeInterviewInput["interviewing"], GoodbyeInterviewingEvent>),
  goodbye: Object.freeze({
    id: "goodbye-interview/1/goodbye",
    finishesParticipation: true,
    input: goodbyeInputSchema,
    event: goodbyeCompletedEventSchema,
  }),
});
export const finishInterviewTool = Object.freeze({
  type: "function" as const,
  name: "finish_interview",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});
export const closingLimitationSchema = z.enum([
  "closing_response_failed",
  "closing_cutoff_exhausted",
  "closing_recovery_uncertain",
  "closing_interrupted",
]);
export const conversationDiagnostics = Object.freeze({
  "conversation.closing_assessment": z.strictObject({
    warnings: z.array(closingLimitationSchema),
    finalizedAt: z.number().int().nonnegative(),
    endReason: z.string(),
  }),
  "conversation.transition": z.strictObject({ from: z.string(), to: z.string() }),
});
const diagnostic = describeDiagnostic(conversationDiagnostics);
/**
 * What each state says, on every execution: Interviewing sends the model the caller's
 * instructions and tool wording, unchanged, and offers `finish_interview`; Goodbye is the
 * caller's closing sentence, which each execution's closing says exactly.
 */
export const goodbyeInterviewContent = declareStateContent(goodbyeInterviewStates, {
  interviewing: {
    contract: goodbyeInterviewStates.interviewing,
    prepare(input): PreparedConversationNode {
      return {
        instructions: structuredClone(input.instructions),
        operationalInstructions: "",
        tools: [{ ...finishInterviewTool, description: input.toolDescriptions.finish_interview }],
      };
    },
  },
  goodbye: {
    contract: goodbyeInterviewStates.goodbye,
    prepare(input): PreparedClosing {
      return { sentence: input.closingSentence };
    },
  },
});
/**
 * What a tool call means in Interviewing, on every execution: `finish_interview` asks to finish,
 * with the call's response and call ids. Any other tool means nothing.
 */
export function interpretGoodbyeInterviewTool(
  invocation: ConversationToolInvocation,
  reporter?: StateReporter<GoodbyeInterviewingEvent>,
): ConversationToolIntent | null {
  if (invocation.toolName !== finishInterviewTool.name) return null;
  return reportToolCall(invocation, reporter, ({ responseId, toolCallId }) => ({
    kind: "finish_intent",
    responseId,
    toolCallId,
  }));
}
/**
 * The closing assessment recorded once the Run is finalized: whether Goodbye completed, and with
 * which of the closing limitations among the completion's warnings.
 */
export function assessGoodbyeInterviewClosing(
  completion: Readonly<{ warnings: readonly string[]; finalizedAt: number; endReason: string }>,
): readonly DiagnosticDescription[] {
  const warnings = completion.warnings.flatMap((warning) => {
    const accepted = closingLimitationSchema.safeParse(warning);
    return accepted.success ? [accepted.data] : [];
  });
  return [
    diagnostic("conversation.closing_assessment", {
      warnings,
      finalizedAt: completion.finalizedAt,
      endReason: completion.endReason,
    }),
  ];
}
export const goodbyeInterviewConversation = declareConversation({
  input: decodeGoodbyeInterviewInput,
  diagnostics: conversationDiagnostics,
  states: goodbyeInterviewStates,
  runtimeEvent: goodbyeRuntimeEventSchema,
  terminalStates: ["complete", "interrupted"],
}).progression({
  initial: "interviewing",
  terminalRoles: { completion: "complete", interruption: "interrupted" },
  timers(accepted, anchor) {
    return anchor.state === "goodbye"
      ? {
          timers: [
            {
              id: "closing",
              deadlineAt: anchor.enteredAt + accepted.maximumClosingDurationMs,
              event: { kind: "closing_time_elapsed" },
            },
          ],
          associatedTimerId: "closing",
        }
      : {
          timers: [
            {
              id: "interviewing",
              deadlineAt: anchor.liveAt + accepted.interviewingDurationMs,
              event: { kind: "interview_time_elapsed" },
            },
          ],
          associatedTimerId: "interviewing",
        };
  },
  selectInput: {
    interviewing: (accepted) => structuredClone(accepted.interviewing),
    goodbye: (accepted) => structuredClone(accepted.goodbye),
  },
  evaluate: {
    interviewing(received) {
      if (received.origin === "runtime" && received.event.kind !== "interview_time_elapsed")
        return {
          target: "complete",
          diagnostics: [
            diagnostic("conversation.transition", { from: "interviewing", to: "complete" }),
          ],
        };
      return {
        target: "goodbye",
        diagnostics: [
          diagnostic("conversation.transition", { from: "interviewing", to: "goodbye" }),
        ],
      };
    },
    goodbye(received) {
      if (received.origin === "runtime" && received.event.kind === "interview_time_elapsed")
        throw new Error("conversation_event_state_invalid");
      return {
        target: "complete",
        diagnostics: [diagnostic("conversation.transition", { from: "goodbye", to: "complete" })],
      };
    },
  },
});
