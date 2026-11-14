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
export const questionsInterviewIdentity = Object.freeze({ id: "questions-interview", version: 1 });
const text = z.string().refine((value) => value.trim().length > 0);
const questionInputSchema = z.strictObject({
  instructions: z.strictObject({ kind: z.literal("literal"), text }),
  toolDescriptions: z.strictObject({ next_question: text, finish_interview: text }),
});
/** Goodbye's input: the sentence the interviewer says to close, which no model generates. */
const goodbyeInputSchema = z.strictObject({ closingSentence: text });
export const questionsInterviewInputSchema = z.strictObject({
  contract: z.literal("questions-interview-input/v1"),
  interviewingDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maximumClosingDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  questions: z.array(questionInputSchema).min(1).max(16),
  goodbye: goodbyeInputSchema,
});
export type QuestionsInterviewInput = z.output<typeof questionsInterviewInputSchema>;
export const decodeQuestionsInterviewInput = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    questionsInterviewInputSchema,
  ),
  convert: (value) => value,
});
export const questionsInterviewingEventSchema = z.strictObject({
  kind: z.enum(["next_question", "finish_intent"]),
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
export type QuestionsInterviewingEvent = z.output<typeof questionsInterviewingEventSchema>;
export const questionsInterviewStates = Object.freeze({
  question: Object.freeze({
    id: "questions-interview/1/question",
    input: questionInputSchema,
    event: questionsInterviewingEventSchema,
  } satisfies ConversationState<
    QuestionsInterviewInput["questions"][number],
    QuestionsInterviewingEvent
  >),
  goodbye: Object.freeze({
    id: "questions-interview/1/goodbye",
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
/** The tool a Question offers to move on: `finish_interview`'s shape under its own name. */
export const nextQuestionTool = Object.freeze({
  type: "function" as const,
  name: "next_question",
  parameters: finishInterviewTool.parameters,
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
  "conversation.transition": z.strictObject({
    from: z.string(),
    to: z.string(),
    questionIndex: z.number().int().nonnegative(),
  }),
});
const diagnostic = describeDiagnostic(conversationDiagnostics);
export const questionContextSchema = z
  .strictObject({
    questionIndex: z.number().int().nonnegative(),
    questionCount: z.number().int().positive(),
  })
  .refine((value) => value.questionIndex < value.questionCount);
type QuestionContext = z.output<typeof questionContextSchema>;
/**
 * What each state says, on every execution: a Question sends the model the caller's instructions
 * and tool wording, unchanged, and offers `next_question` and `finish_interview`; Goodbye is the
 * caller's closing sentence, which each execution's closing says exactly.
 */
export const questionsInterviewContent = declareStateContent(questionsInterviewStates, {
  question: {
    contract: questionsInterviewStates.question,
    prepare(input): PreparedConversationNode {
      return {
        instructions: structuredClone(input.instructions),
        operationalInstructions: "",
        tools: [
          { ...nextQuestionTool, description: input.toolDescriptions.next_question },
          { ...finishInterviewTool, description: input.toolDescriptions.finish_interview },
        ],
      };
    },
  },
  goodbye: {
    contract: questionsInterviewStates.goodbye,
    prepare(input): PreparedClosing {
      return { sentence: input.closingSentence };
    },
  },
});
/**
 * What a tool call means in a Question, on every execution: `next_question` asks to move on and
 * `finish_interview` asks to finish, each with the call's response and call ids. Any other tool
 * means nothing.
 */
export function interpretQuestionsInterviewTool(
  invocation: ConversationToolInvocation,
  reporter?: StateReporter<QuestionsInterviewingEvent>,
): ConversationToolIntent | null {
  const kind =
    invocation.toolName === nextQuestionTool.name
      ? "next_question"
      : invocation.toolName === finishInterviewTool.name
        ? "finish_intent"
        : null;
  if (kind === null) return null;
  return reportToolCall(invocation, reporter, ({ responseId, toolCallId }) => ({
    kind,
    responseId,
    toolCallId,
  }));
}
/**
 * The closing assessment recorded once the Run is finalized: whether Goodbye completed, and with
 * which of the closing limitations among the completion's warnings.
 */
export function assessQuestionsInterviewClosing(
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
export const questionsInterviewConversation = declareConversation({
  input: decodeQuestionsInterviewInput,
  diagnostics: conversationDiagnostics,
  context: {
    schema: questionContextSchema,
    initial: (accepted) => ({ questionIndex: 0, questionCount: accepted.questions.length }),
  },
  states: questionsInterviewStates,
  runtimeEvent: goodbyeRuntimeEventSchema,
  terminalStates: ["complete", "interrupted"],
}).progression({
  initial: "question",
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
    question(accepted, { context }) {
      const question = accepted.questions.at(context.questionIndex);
      if (context.questionCount !== accepted.questions.length || question === undefined)
        throw new Error("question_definition_conflict");
      return structuredClone(question);
    },
    goodbye(accepted, { context }) {
      if (context.questionCount !== accepted.questions.length)
        throw new Error("question_definition_conflict");
      return structuredClone(accepted.goodbye);
    },
  },
  evaluate: {
    question(received, context) {
      if (received.origin === "runtime") {
        const target = received.event.kind === "interview_time_elapsed" ? "goodbye" : "complete";
        return transition("question", target, context);
      }
      if (received.event.kind === "finish_intent")
        return transition("question", "goodbye", context);
      if (context.questionIndex + 1 >= context.questionCount)
        return { target: null, context, diagnostics: [] };
      return transition("question", "question", {
        ...context,
        questionIndex: context.questionIndex + 1,
      });
    },
    goodbye(_received, context) {
      return transition("goodbye", "complete", context);
    },
  },
});
function transition<const Target extends string>(
  from: string,
  target: Target,
  context: QuestionContext,
) {
  return {
    target,
    context,
    diagnostics: [
      diagnostic("conversation.transition", {
        from,
        to: target,
        questionIndex: context.questionIndex,
      }),
    ],
  };
}
