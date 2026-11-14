import {
  implementExecutionHandlers,
  type BoundRuntimeImplementation,
  type ReporterFactory,
  type RuntimeImplementationDefinition,
} from "../../runtime/admission/private/implementation.ts";
import type { NativeNodeEntry } from "../../runtime/implementationContracts.ts";
import {
  assessGoodbyeInterviewClosing,
  goodbyeInterviewContent,
  goodbyeInterviewConversation,
  goodbyeInterviewStates,
  interpretGoodbyeInterviewTool,
} from "../../conversations/goodbyeInterview.ts";
import type { CascadeSessionConfiguration } from "../../providers/cascade/runtimeSession.ts";

/** The Cascade Goodbye session enters the Goodbye node with its typed input and reporter. */
export type CascadeGoodbyeNodes = NativeNodeEntry<typeof goodbyeInterviewStates>;

/**
 * Cascade Goodbye's configuration of the kit's session: it opens with Interviewing, which offers
 * `finish_interview`, and its Goodbye node is the kit's closing, which reports
 * `goodbye_completed` with the delivered closing's output identity.
 */
export const cascadeGoodbyeSessionConfiguration = {
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
} satisfies CascadeSessionConfiguration<typeof goodbyeInterviewStates>;

export const cascadeGoodbyeImplementation: RuntimeImplementationDefinition<
  typeof goodbyeInterviewConversation,
  CascadeGoodbyeNodes
> = {
  id: "goodbye-interview/1/cascade",
  executionHandlers: implementExecutionHandlers(goodbyeInterviewStates, {
    interviewing: {
      contract: goodbyeInterviewStates.interviewing,
      policy: "native",
      // Interviewing is served by the session's opening; it has no node entry.
      enter: () => {
        throw new Error("native_node_unavailable");
      },
      bind: bindInterviewingReporting,
    },
    goodbye: {
      contract: goodbyeInterviewStates.goodbye,
      policy: "native",
      enter: (input, native: CascadeGoodbyeNodes) => native.enterNode(input),
      bind: bindGoodbyeReporting,
    },
  }),
  conversation: goodbyeInterviewConversation,
  finalizedDiagnostics: assessGoodbyeInterviewClosing,
  // A session is prepared for the initial Interviewing node only.
  prepare(input) {
    const { opening } = cascadeGoodbyeSessionConfiguration;
    if (input.state !== opening.state) throw new Error("conversation_node_preparation_unavailable");
    return structuredClone(opening.content(input.nodeInput));
  },
  interpretTool: (invocation) => interpretGoodbyeInterviewTool(invocation),
};

/** Cascade Goodbye's reporting: Interviewing reports what each tool call means. */
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
