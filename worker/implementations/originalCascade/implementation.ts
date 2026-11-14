import {
  implementExecutionHandlers,
  type BoundRuntimeImplementation,
  type ReporterFactory,
  type RuntimeImplementationDefinition,
} from "../../runtime/admission/private/implementation.ts";
import {
  interpretOriginalInterviewTool,
  originalInterviewContent,
  originalInterviewConversation,
  originalInterviewStates,
} from "../../conversations/originalInterview.ts";
import type { CascadeSessionConfiguration } from "../../providers/cascade/runtimeSession.ts";

/**
 * Cascade Original's configuration of the kit's session: it opens with Interviewing, which
 * offers `finish_interview`, and enters no node. Its finishing is the kit's default once
 * Runtime closes participant input at the finish: the output of the response that called
 * `finish_interview` plays to its end, and no listening follows it.
 */
export const cascadeOriginalSessionConfiguration = {
  opening: {
    state: "interviewing",
    content: (input) => originalInterviewContent.interviewing.prepare(input),
  },
  nodes: {},
} satisfies CascadeSessionConfiguration<typeof originalInterviewStates>;

export const cascadeOriginalImplementation: RuntimeImplementationDefinition<
  typeof originalInterviewConversation
> = {
  id: "original-interview/1/cascade",
  executionHandlers: implementExecutionHandlers(originalInterviewStates, {
    interviewing: {
      contract: originalInterviewStates.interviewing,
      policy: "native",
      // Interviewing is served by the session's opening; it has no node entry.
      enter: () => {
        throw new Error("native_node_unavailable");
      },
      bind: bindInterviewingReporting,
    },
    finishing: {
      contract: originalInterviewStates.finishing,
      policy: "retained_output",
      enter: null,
      bind: bindFinishingReporting,
    },
  }),
  conversation: originalInterviewConversation,
  // Both states declare the Interviewing input; a session presents Interviewing content.
  prepare({ nodeInput }) {
    return structuredClone(cascadeOriginalSessionConfiguration.opening.content(nodeInput));
  },
  interpretTool: (invocation) => interpretOriginalInterviewTool(invocation),
};

/** Cascade Original's reporting: Interviewing reports what each tool call means. */
function bindInterviewingReporting(issue: ReporterFactory): BoundRuntimeImplementation<"native"> {
  const reporter = issue(originalInterviewStates.interviewing);
  return {
    reporting: { kind: "native" },
    interpretTool: (invocation) => interpretOriginalInterviewTool(invocation, reporter),
  };
}

/**
 * An admitted `finish_interview` enters finishing with the output of the response that called
 * it, which keeps its identity and its ten-second permission. Finishing completes once that
 * output's model response completed and the server delivered its audio, without waiting for
 * browser playback. A response that failed, or was cancelled before Runtime's own cleanup,
 * fails the finish; after that cleanup, the finishing deadline completes it.
 */
function bindFinishingReporting(
  issue: ReporterFactory,
): BoundRuntimeImplementation<"retained_output"> {
  const reporter = issue(originalInterviewStates.finishing);
  return {
    interpretTool: () => null,
    reporting: {
      kind: "retained_output",
      observe(proof) {
        if (
          proof.responseSettlement === "failed" ||
          proof.responseSettlement === "incomplete" ||
          (proof.responseSettlement === "cancelled" && !proof.cleanupClaimed)
        )
          return { kind: "failed", reason: "retained_output_failed" };
        if (proof.responseSettlement !== "completed" || proof.outputAudioSettlement !== "stopped")
          return { kind: "pending" };
        const report = reporter.report({ kind: "output_completed" });
        return report === null ? { kind: "pending" } : { kind: "report", report };
      },
    },
  };
}
