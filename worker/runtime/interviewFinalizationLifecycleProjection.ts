import {
  type RuntimeEndReason,
  type InterviewFinalizationAggregate,
  type RuntimeFinalizationCompletion,
} from "./interviewFinalizationModel.ts";

export type InterviewFinalizationPhase = "live" | "ending" | "ended";

export type InterviewFinalizationPendingClose = Readonly<{
  endReason: RuntimeEndReason;
  source: string;
  requestedAt: number;
  fallbackAt?: number;
}>;

export type InterviewFinalizationLifecycle = Readonly<{
  phase: InterviewFinalizationPhase;
  pendingClose: InterviewFinalizationPendingClose | null;
  completion: RuntimeFinalizationCompletion | null;
}>;

export function projectInterviewFinalizationLifecycle(
  aggregate: InterviewFinalizationAggregate,
): InterviewFinalizationLifecycle {
  const state = aggregate.state;

  switch (state.stage) {
    case "live":
      return { phase: "live", pendingClose: null, completion: null };
    case "draining":
      return {
        phase: "ending",
        pendingClose: {
          endReason: state.endReason,
          source: state.source,
          requestedAt: state.endingStartedAt,
          fallbackAt: state.finalizationCutoffAt,
        },
        completion: null,
      };
    case "closing_provider":
      return {
        phase: "ending",
        pendingClose: {
          endReason: state.endReason,
          source: state.source,
          requestedAt: state.endingStartedAt,
          fallbackAt: state.finalizationCutoffAt,
        },
        completion: null,
      };
    case "finalizing":
      return {
        phase: "ending",
        pendingClose: {
          endReason: state.endReason,
          source: state.source,
          requestedAt: state.endingStartedAt,
        },
        completion: null,
      };
    case "ended":
      return { phase: "ended", pendingClose: null, completion: state.completion };
    default:
      return assertUnreachable(state);
  }
}

function assertUnreachable(value: never): never {
  throw new Error(`Unsupported Interview finalization state: ${JSON.stringify(value)}`);
}
