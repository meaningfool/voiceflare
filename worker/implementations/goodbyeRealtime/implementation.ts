import {
  implementExecutionHandlers,
  type BoundRuntimeImplementation,
  type ReporterFactory,
  type RuntimeImplementationDefinition,
} from "../../runtime/admission/private/implementation.ts";
import type { NativeNodeEntry } from "../../runtime/implementationContracts.ts";
import type { RealtimeSessionConfiguration } from "../../providers/openaiRealtime/session.ts";
import {
  assessGoodbyeInterviewClosing,
  goodbyeInterviewContent,
  goodbyeInterviewConversation,
  goodbyeInterviewStates,
  interpretGoodbyeInterviewTool,
} from "../../conversations/goodbyeInterview.ts";
/** The Goodbye session enters each dispatched node with that state's typed input and reporter. */
export type GoodbyeNativeNodes = NativeNodeEntry<typeof goodbyeInterviewStates>;

/**
 * Realtime Goodbye's configuration of the kit's session: it opens with Interviewing, which offers
 * `finish_interview`, and its Goodbye node is the kit's closing, which reports
 * `goodbye_completed` with the delivered closing reply's id.
 */
export const goodbyeRealtimeSessionConfiguration = {
  opening: {
    state: "interviewing",
    content: (input) => goodbyeInterviewContent.interviewing.prepare(input),
  },
  nodes: {
    goodbye: {
      operation: "closing",
      content: (input) => goodbyeInterviewContent.goodbye.prepare(input),
      completed: (responseId) => ({ kind: "goodbye_completed", responseId }),
    },
  },
} satisfies RealtimeSessionConfiguration<typeof goodbyeInterviewStates>;

export const goodbyeRealtimeImplementation: RuntimeImplementationDefinition<
  typeof goodbyeInterviewConversation,
  GoodbyeNativeNodes
> = {
  id: "goodbye-interview/1/realtime",
  executionHandlers: implementExecutionHandlers(goodbyeInterviewStates, {
    interviewing: {
      contract: goodbyeInterviewStates.interviewing,
      policy: "native",
      enter: (input, native: GoodbyeNativeNodes) => native.enterNode(input),
      bind: bindInterviewingReporting,
    },
    goodbye: {
      contract: goodbyeInterviewStates.goodbye,
      policy: "native",
      enter: (input, native: GoodbyeNativeNodes) => native.enterNode(input),
      bind: bindGoodbyeReporting,
    },
  }),
  conversation: goodbyeInterviewConversation,
  finalizedDiagnostics: assessGoodbyeInterviewClosing,
  // A session is prepared for the initial Interviewing node only.
  prepare(input) {
    const { opening } = goodbyeRealtimeSessionConfiguration;
    if (input.state !== opening.state) throw new Error("conversation_node_preparation_unavailable");
    return structuredClone(opening.content(input.nodeInput));
  },
  interpretTool: (invocation) => interpretGoodbyeInterviewTool(invocation),
};

/** Realtime Goodbye's reporting: Interviewing reports what each tool call means. */
function bindInterviewingReporting(issue: ReporterFactory): BoundRuntimeImplementation<"native"> {
  const reporter = issue(goodbyeInterviewStates.interviewing);
  return {
    reporting: { kind: "native" },
    interpretTool: (invocation) => interpretGoodbyeInterviewTool(invocation, reporter),
  };
}

/** Goodbye's completion comes from its node entry; a tool call there reports nothing. */
function bindGoodbyeReporting(): BoundRuntimeImplementation<"native"> {
  return { reporting: { kind: "native" }, interpretTool: () => null };
}
