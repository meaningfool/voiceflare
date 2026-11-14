import {
  implementExecutionHandlers,
  type BoundRuntimeImplementation,
  type ReporterFactory,
  type RuntimeImplementationDefinition,
} from "../../runtime/admission/private/implementation.ts";
import type { NativeNodeEntry } from "../../runtime/implementationContracts.ts";
import {
  assessQuestionsInterviewClosing,
  interpretQuestionsInterviewTool,
  questionsInterviewContent,
  questionsInterviewConversation,
  questionsInterviewStates,
} from "../../conversations/questionsInterview.ts";
import type { CascadeSessionConfiguration } from "../../providers/cascade/runtimeSession.ts";

/** The Cascade Questions session enters each dispatched node with its typed input and reporter. */
export type CascadeQuestionsNodes = NativeNodeEntry<typeof questionsInterviewStates>;

/**
 * Cascade Questions' configuration of the kit's session: it opens with the first Question, each
 * later Question is a conversing phase with that question's content, and its Goodbye node is
 * the kit's closing, as Cascade Goodbye's. An accepted `next_question` thus cuts speech in the
 * reply that called it, and the next question is asked at once, with no listening between
 * them. A `next_question` on the last question, which the Conversation does
 * not advance, enters nothing: listening opens after that reply.
 */
export const cascadeQuestionsSessionConfiguration = {
  opening: {
    state: "question",
    content: (input) => questionsInterviewContent.question.prepare(input),
  },
  nodes: {
    question: {
      operation: "conversing",
      content: (input) => questionsInterviewContent.question.prepare(input),
    },
    goodbye: {
      operation: "closing",
      content: (input) => questionsInterviewContent.goodbye.prepare(input),
      completed: (responseId) => ({ kind: "goodbye_completed", responseId }),
    },
  },
} satisfies CascadeSessionConfiguration<typeof questionsInterviewStates>;

export const cascadeQuestionsImplementation: RuntimeImplementationDefinition<
  typeof questionsInterviewConversation,
  CascadeQuestionsNodes
> = {
  id: "questions-interview/1/cascade",
  executionHandlers: implementExecutionHandlers(questionsInterviewStates, {
    question: {
      contract: questionsInterviewStates.question,
      policy: "native",
      enter: (input, native: CascadeQuestionsNodes) => native.enterNode(input),
      bind: bindQuestionReporting,
    },
    goodbye: {
      contract: questionsInterviewStates.goodbye,
      policy: "native",
      enter: (input, native: CascadeQuestionsNodes) => native.enterNode(input),
      bind: bindGoodbyeReporting,
    },
  }),
  conversation: questionsInterviewConversation,
  finalizedDiagnostics: assessQuestionsInterviewClosing,
  // A session is prepared for the initial Question node only.
  prepare(input) {
    const { opening } = cascadeQuestionsSessionConfiguration;
    if (input.state !== opening.state) throw new Error("conversation_node_preparation_unavailable");
    return structuredClone(opening.content(input.nodeInput));
  },
  interpretTool: (invocation) => interpretQuestionsInterviewTool(invocation),
};

/** Cascade Questions' reporting: a Question reports what each tool call means. */
function bindQuestionReporting(issue: ReporterFactory): BoundRuntimeImplementation<"native"> {
  const reporter = issue(questionsInterviewStates.question);
  return {
    reporting: { kind: "native" },
    interpretTool: (invocation) => interpretQuestionsInterviewTool(invocation, reporter),
  };
}

/** Goodbye's completion comes from its node entry; a tool call there reports nothing. */
function bindGoodbyeReporting(): BoundRuntimeImplementation<"native"> {
  return { reporting: { kind: "native" }, interpretTool: () => null };
}
