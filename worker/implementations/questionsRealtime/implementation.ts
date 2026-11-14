import {
  implementExecutionHandlers,
  type BoundRuntimeImplementation,
  type ReporterFactory,
  type RuntimeImplementationDefinition,
} from "../../runtime/admission/private/implementation.ts";
import type { NativeNodeEntry } from "../../runtime/implementationContracts.ts";
import type { RealtimeSessionConfiguration } from "../../providers/openaiRealtime/session.ts";
import {
  assessQuestionsInterviewClosing,
  interpretQuestionsInterviewTool,
  questionsInterviewContent,
  questionsInterviewConversation,
  questionsInterviewStates,
} from "../../conversations/questionsInterview.ts";
/** The Questions session enters each dispatched node with that state's typed input and reporter. */
export type QuestionsNativeNodes = NativeNodeEntry<typeof questionsInterviewStates>;

/**
 * Realtime Questions' configuration of the kit's session: it opens with its first Question, each
 * later Question is the kit's conversing phase with that Question's content, and its Goodbye
 * node is the kit's closing, which reports `goodbye_completed` with the delivered closing reply's
 * id.
 */
export const questionsRealtimeSessionConfiguration = {
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
} satisfies RealtimeSessionConfiguration<typeof questionsInterviewStates>;

export const questionsRealtimeImplementation: RuntimeImplementationDefinition<
  typeof questionsInterviewConversation,
  QuestionsNativeNodes
> = {
  id: "questions-interview/1/realtime",
  executionHandlers: implementExecutionHandlers(questionsInterviewStates, {
    question: {
      contract: questionsInterviewStates.question,
      policy: "native",
      enter: (input, native: QuestionsNativeNodes) => native.enterNode(input),
      bind: bindQuestionReporting,
    },
    goodbye: {
      contract: questionsInterviewStates.goodbye,
      policy: "native",
      enter: (input, native: QuestionsNativeNodes) => native.enterNode(input),
      bind: bindGoodbyeReporting,
    },
  }),
  conversation: questionsInterviewConversation,
  finalizedDiagnostics: assessQuestionsInterviewClosing,
  // A session is prepared for the initial Question node only.
  prepare(input) {
    const { opening } = questionsRealtimeSessionConfiguration;
    if (input.state !== opening.state) throw new Error("conversation_node_preparation_unavailable");
    return structuredClone(opening.content(input.nodeInput));
  },
  interpretTool: (invocation) => interpretQuestionsInterviewTool(invocation),
};

/** Realtime Questions' reporting: a Question reports what each tool call means. */
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
