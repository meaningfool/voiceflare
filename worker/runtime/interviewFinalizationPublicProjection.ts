import {
  type InterviewFinalizationAggregate,
  type InterviewFinalizationState,
  type RuntimeFinalizationCompletion,
} from "./interviewFinalizationModel.ts";

import {
  projectInterviewFinalizationLifecycle,
  type InterviewFinalizationPhase,
  type InterviewFinalizationPendingClose,
} from "./interviewFinalizationLifecycleProjection.ts";

export type InterviewFinalizationPublicState = Readonly<{
  conversation: Readonly<{ state: string; deadlineAt: number | null }> | null;
  phase: InterviewFinalizationPhase;
  stage: InterviewFinalizationState["stage"];
  ending: boolean;
  terminal: boolean;
  pendingClose: InterviewFinalizationPendingClose | null;
  completion: RuntimeFinalizationCompletion | null;
}>;

export function projectInterviewFinalizationPublicState(
  aggregate: InterviewFinalizationAggregate,
): InterviewFinalizationPublicState {
  const state = aggregate.state;
  const lifecycle = projectInterviewFinalizationLifecycle(aggregate);
  return {
    ...lifecycle,
    conversation:
      aggregate.conversationVisit === undefined
        ? null
        : {
            state: aggregate.conversationVisit.state,
            deadlineAt:
              aggregate.state.stage === "live"
                ? (aggregate.conversationNodeExecution?.timers.find(
                    (timer) => timer.id === aggregate.conversationNodeExecution?.associatedTimerId,
                  )?.deadlineAt ?? null)
                : null,
          },
    stage: state.stage,
    ending: lifecycle.phase !== "live",
    terminal: lifecycle.phase === "ended",
  };
}
