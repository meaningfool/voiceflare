import { z } from "zod";
import { describeDiagnostic } from "../runtime/diagnosticContracts.ts";
import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  declareConversation,
  declareStateContent,
  reportToolCall,
  type ConversationState,
} from "../runtime/conversationContracts.ts";
import type { StateReporter } from "../runtime/executionContracts.ts";
import type {
  ConversationToolIntent,
  ConversationToolInvocation,
  PreparedConversationNode,
} from "../runtime/nodeContentContracts.ts";

/** This Conversation's identity, as the registry, Lab and the voice suite name it. */
export const originalInterviewIdentity = Object.freeze({ id: "original-interview", version: 1 });

type PromptReference = {
  id: string;
  version?: string;
  variables?: Record<string, string | number | boolean>;
};
const text = z.string().refine((value) => value.trim().length > 0);
const referenceSchema = z
  .strictObject({
    id: text,
    version: text.optional(),
    variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .transform((value): PromptReference => {
    const reference: PromptReference = { id: value.id };
    if (value.version !== undefined) reference.version = value.version;
    if (value.variables !== undefined) reference.variables = value.variables;
    return reference;
  });
const instructionsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), text }),
  z.strictObject({
    kind: z.literal("provider_prompt"),
    reference: referenceSchema,
    supplementalText: z.string(),
  }),
]);
const interviewingInputSchema = z.strictObject({
  instructions: instructionsSchema,
  toolDescriptions: z.strictObject({ finish_interview: text }),
});
export const originalInterviewInputSchema = z.strictObject({
  contract: z.literal("original-interview-input/v1"),
  interviewingDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  interviewing: interviewingInputSchema,
});
export type OriginalInterviewInput = z.output<typeof originalInterviewInputSchema>;
export const decodeOriginalInterviewInput = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    originalInterviewInputSchema,
  ),
  convert: (value) => value,
});
export const originalInterviewEventSchema = z.strictObject({
  kind: z.literal("finish_intent"),
  responseId: text,
  toolCallId: text,
});
export type OriginalInterviewEvent = z.output<typeof originalInterviewEventSchema>;
const finishingEventSchema = z.strictObject({ kind: z.literal("output_completed") });
export const originalInterviewStates = Object.freeze({
  finishing: Object.freeze({
    id: "original-interview/1/finishing",
    finishesParticipation: true,
    input: interviewingInputSchema,
    event: finishingEventSchema,
  }),
  interviewing: Object.freeze({
    id: "original-interview/1/interviewing",
    input: interviewingInputSchema,
    event: originalInterviewEventSchema,
  } satisfies ConversationState<OriginalInterviewInput["interviewing"], OriginalInterviewEvent>),
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
/**
 * What the model receives in each state, on every execution: the caller's instructions and tool
 * wording, unchanged. A provider prompt reference is sent as the prompt, with its supplemental
 * text as operational instructions. Finishing sends the model nothing: it keeps the output of the
 * reply that called `finish_interview`.
 */
export const originalInterviewContent = declareStateContent(originalInterviewStates, {
  interviewing: {
    contract: originalInterviewStates.interviewing,
    prepare(input): PreparedConversationNode {
      return {
        instructions:
          input.instructions.kind === "literal"
            ? { kind: "literal", text: input.instructions.text }
            : { kind: "provider_prompt", prompt: structuredClone(input.instructions.reference) },
        operationalInstructions:
          input.instructions.kind === "provider_prompt" ? input.instructions.supplementalText : "",
        tools: [{ ...finishInterviewTool, description: input.toolDescriptions.finish_interview }],
      };
    },
  },
  finishing: { contract: originalInterviewStates.finishing, prepare: null },
});
/**
 * What a tool call means in Interviewing, on every execution: `finish_interview` asks to finish,
 * with the call's response and call ids. Any other tool means nothing.
 */
export function interpretOriginalInterviewTool(
  invocation: ConversationToolInvocation,
  reporter?: StateReporter<OriginalInterviewEvent>,
): ConversationToolIntent | null {
  if (invocation.toolName !== finishInterviewTool.name) return null;
  // The finish call's arguments stay tolerated: its correlated identities, not undeclared
  // native argument coercion, make the typed event.
  return reportToolCall(invocation, reporter, ({ responseId, toolCallId }) => ({
    kind: "finish_intent",
    responseId,
    toolCallId,
  }));
}
/** Pure normal progression. Failures and deadlines belong to the surrounding Run. */
export const conversationDiagnostics = Object.freeze({
  "conversation.transition": z.strictObject({ from: z.string(), to: z.string() }),
});
const diagnostic = describeDiagnostic(conversationDiagnostics);
export const originalInterviewConversation = declareConversation({
  input: decodeOriginalInterviewInput,
  diagnostics: conversationDiagnostics,
  runtimeEvent: z.strictObject({
    kind: z.enum(["interview_time_elapsed", "finishing_time_elapsed", "participant_stopped"]),
  }),
  states: originalInterviewStates,
  terminalStates: ["complete", "interrupted"],
}).progression({
  initial: "interviewing",
  terminalRoles: { completion: "complete", interruption: "interrupted" },
  timers(accepted, anchor) {
    if (anchor.state === "finishing")
      return {
        timers: [
          {
            id: "finishing",
            deadlineAt: anchor.enteredAt + 10_000,
            event: { kind: "finishing_time_elapsed" },
          },
        ],
        associatedTimerId: "finishing",
        retainedOutputCleanupAt: anchor.enteredAt + 6_000,
      };
    return {
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
    finishing: (accepted) => structuredClone(accepted.interviewing),
  },
  evaluate: {
    interviewing(received) {
      const target = received.origin === "runtime" ? "complete" : "finishing";
      return {
        target,
        diagnostics: [diagnostic("conversation.transition", { from: "interviewing", to: target })],
      };
    },
    finishing() {
      return {
        target: "complete",
        diagnostics: [diagnostic("conversation.transition", { from: "finishing", to: "complete" })],
      };
    },
  },
});
