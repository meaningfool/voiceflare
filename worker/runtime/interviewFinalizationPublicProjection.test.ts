import { describe, expect, it } from "vitest";

import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";

import {
  type InterviewFinalizationAggregate,
  type InterviewFinalizationState,
  type RuntimeFinalizationCompletion,
} from "./interviewFinalizationModel.ts";
import { projectInterviewFinalizationPublicState } from "./interviewFinalizationPublicProjection.ts";

const endingState = {
  endReason: "participant_stopped",
  source: "browser_request",
  strategy: "hard_stop",
  endingStartedAt: 100,
  finalizationCutoffAt: 300,
  activeInputItemId: null,
  activeResponseId: null,
  admittedResponseId: null,
  sessionClosed: false,
  effects: [],
  warnings: [],
} as const;

const completion = {
  runId: "run_public_projection",
  outcome: "failed",
  endReason: "runtime_failed",
  source: "runtime_controller",
  endingStartedAt: 100,
  endedAt: 400,
  finalizationCutoffAt: 10_100,
  finalizedAt: 450,
  transcriptSnapshot: {
    revision: 2,
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    turnCount: 1,
  },
  warnings: [],
} as const satisfies RuntimeFinalizationCompletion;

describe("Interview finalization public projection", () => {
  it.each([
    {
      stage: "live",
      state: liveAggregate().state,
      expected: {
        phase: "live",
        stage: "live",
        ending: false,
        terminal: false,
        pendingClose: null,
        completion: null,
      },
    },
    {
      stage: "draining",
      state: {
        stage: "draining",
        ...endingState,
        outputAudioActive: false,
      },
      finalInputQuietDeadline: 250,
      expected: {
        phase: "ending",
        stage: "draining",
        ending: true,
        terminal: false,
        pendingClose: {
          endReason: "participant_stopped",
          source: "browser_request",
          requestedAt: 100,
          fallbackAt: 300,
        },
        completion: null,
      },
    },
    {
      stage: "closing_provider",
      state: {
        stage: "closing_provider",
        ...endingState,
        outputAudioActive: false,
      },
      expected: {
        phase: "ending",
        stage: "closing_provider",
        ending: true,
        terminal: false,
        pendingClose: {
          endReason: "participant_stopped",
          source: "browser_request",
          requestedAt: 100,
          fallbackAt: 300,
        },
        completion: null,
      },
    },
    {
      stage: "finalizing",
      state: { stage: "finalizing", ...endingState },
      expected: {
        phase: "ending",
        stage: "finalizing",
        ending: true,
        terminal: false,
        pendingClose: {
          endReason: "participant_stopped",
          source: "browser_request",
          requestedAt: 100,
        },
        completion: null,
      },
    },
    {
      stage: "ended",
      state: {
        stage: "ended",
        completion,
        publication: {
          status: "pending",
          publicationCutoffAt: 30_450,
          transcriptDelivered: false,
          completionDelivered: false,
          retryAt: null,
          attemptCount: 0,
          deliveredAt: null,
          lastError: null,
        },
        effects: [],
      },
      expected: {
        phase: "ended",
        stage: "ended",
        ending: true,
        terminal: true,
        pendingClose: null,
        completion,
      },
    },
  ] as const)("projects the $stage stage", ({ state, finalInputQuietDeadline, expected }) => {
    expect(
      projectInterviewFinalizationPublicState(aggregateWithState(state, finalInputQuietDeadline)),
    ).toEqual({ ...expected, conversation: null });
  });

  it("uses the drain deadline when no final-input quiet deadline exists", () => {
    const aggregate = aggregateWithState({
      stage: "draining",
      ...endingState,
      outputAudioActive: false,
    });

    expect(projectInterviewFinalizationPublicState(aggregate).pendingClose).toMatchObject({
      fallbackAt: 300,
    });
  });
});

function liveAggregate(): InterviewFinalizationAggregate {
  return liveFinalizationAggregate({ runId: "run_public_projection" });
}

function aggregateWithState(
  state: InterviewFinalizationState,
  finalInputQuietDeadline?: number,
): InterviewFinalizationAggregate {
  const aggregate = liveAggregate();
  return {
    ...aggregate,
    state,
    finalInput:
      finalInputQuietDeadline === undefined
        ? null
        : {
            admissionCutoffAt: 1,
            fence: { generation: 1, sequence: 1 },
            effectId: "effect-final-input",
            obligation: "awaiting_transcription",
            admittedItemId: "item-final-input",
            inputToSettle: true,
            answerFollows: false,
            quietDeadline: finalInputQuietDeadline,
            duplicateCount: 0,
            warning: null,
          },
  };
}
