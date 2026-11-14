import {
  implementExecutionHandlers,
  type BoundRuntimeImplementation,
  type ReporterFactory,
  type RuntimeImplementationDefinition,
} from "../../runtime/admission/private/implementation.ts";
import {
  interpretOriginalInterviewTool,
  originalInterviewContent,
  originalInterviewStates,
  originalInterviewConversation,
} from "../../conversations/originalInterview.ts";
import type { RealtimeSessionConfiguration } from "../../providers/openaiRealtime/session.ts";

export const FINISH_INTERVIEW_TOOL_NAME = "finish_interview";

/**
 * Realtime Original's configuration of the kit's session: it opens with Interviewing, which
 * offers `finish_interview`, and enters no node. Its finishing keeps the reply that finished,
 * the kit's default when input closes and nothing else is entered.
 */
export const originalRealtimeSessionConfiguration = {
  opening: {
    state: "interviewing",
    content: (input) => originalInterviewContent.interviewing.prepare(input),
  },
  nodes: {},
} satisfies RealtimeSessionConfiguration<typeof originalInterviewStates>;

export const originalRealtimeImplementation: RuntimeImplementationDefinition<
  typeof originalInterviewConversation
> = {
  id: "original-interview/1/realtime",
  executionHandlers: implementExecutionHandlers(originalInterviewStates, {
    interviewing: {
      contract: originalInterviewStates.interviewing,
      policy: "native",
      // Original Interviewing is served by its opening session; it has no node entry.
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
    return structuredClone(originalRealtimeSessionConfiguration.opening.content(nodeInput));
  },
  interpretTool: (invocation) => interpretOriginalInterviewTool(invocation),
};

export const interviewAgent = originalRealtimeImplementation;

/** Realtime Original's reporting: Interviewing reports what each tool call means. */
function bindInterviewingReporting(issue: ReporterFactory): BoundRuntimeImplementation<"native"> {
  const reporter = issue(originalInterviewStates.interviewing);
  return {
    reporting: { kind: "native" },
    interpretTool: (invocation) => interpretOriginalInterviewTool(invocation, reporter),
  };
}

/**
 * Finishing keeps the output of the response that called `finish_interview` and reports once
 * that response is no longer pending and its audio stopped. A response that failed, or was
 * cancelled before Runtime's own cleanup, fails the finish.
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
        if (proof.responseSettlement === "pending" || proof.outputAudioSettlement !== "stopped")
          return { kind: "pending" };
        const report = reporter.report({ kind: "output_completed" });
        return report === null ? { kind: "pending" } : { kind: "report", report };
      },
    },
  };
}
