import { describe, expect, it } from "vitest";

import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";

import {
  type InterviewFinalizationAggregate,
  type InterviewFinalizationState,
  type RuntimeFinalizationCompletion,
  type RuntimePublicationState,
  type SerializedTranscriptCapture,
} from "./interviewFinalizationModel.ts";
import { projectInterviewFinalizationPersistence } from "./interviewFinalizationPersistenceProjection.ts";

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
  runId: "run_persistence_projection",
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

const publicationBase = {
  publicationCutoffAt: 30_450,
  transcriptDelivered: false,
  completionDelivered: false,
  attemptCount: 3,
} as const;

const pendingPublication = {
  ...publicationBase,
  status: "pending",
  retryAt: null,
  deliveredAt: null,
  lastError: null,
} as const satisfies RuntimePublicationState;

const frozenCapture = capture("frozen_item", "Frozen terminal turn");

describe("Interview finalization persistence projection", () => {
  it.each([
    {
      stage: "live",
      state: liveAggregate().state,
      expected: {
        phase: "live",
        deadlineAt: 900,
        pendingClose: null,
        completion: null,
        frozenTranscript: null,
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
        deadlineAt: 300,
        pendingClose: {
          endReason: "participant_stopped",
          source: "browser_request",
          requestedAt: 100,
          fallbackAt: 300,
        },
        completion: null,
        frozenTranscript: null,
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
        deadlineAt: 300,
        pendingClose: {
          endReason: "participant_stopped",
          source: "browser_request",
          requestedAt: 100,
          fallbackAt: 300,
        },
        completion: null,
        frozenTranscript: null,
      },
    },
    {
      stage: "finalizing",
      state: { stage: "finalizing", ...endingState },
      expected: {
        phase: "ending",
        deadlineAt: null,
        pendingClose: {
          endReason: "participant_stopped",
          source: "browser_request",
          requestedAt: 100,
        },
        completion: null,
        frozenTranscript: null,
      },
    },
    {
      stage: "ended",
      state: endedState(pendingPublication),
      expected: {
        phase: "ended",
        deadlineAt: null,
        pendingClose: null,
        completion,
        frozenTranscript: {
          turns: [{ role: "participant", text: "Frozen terminal turn" }],
          ...completion.transcriptSnapshot,
        },
      },
    },
  ] as const)("projects the $stage stage", ({ state, finalInputQuietDeadline, expected }) => {
    const aggregate = aggregateWithState(state, finalInputQuietDeadline);
    expect(project(aggregate)).toMatchObject(expected);
  });

  it("uses the drain deadline without a final-input quiet deadline", () => {
    const aggregate = aggregateWithState({
      stage: "draining",
      ...endingState,
      outputAudioActive: false,
    });

    expect(project(aggregate).deadlineAt).toBe(300);
  });

  it("projects the terminal frozen transcript from the sealed capture", () => {
    const projection = project(aggregateWithState(endedState(pendingPublication)));
    expect(projection.transcriptTurns).toEqual([
      { role: "participant", text: "Frozen terminal turn" },
    ]);
    expect(projection.frozenTranscript?.turns).toEqual(projection.transcriptTurns);
  });

  it.each([
    {
      status: "pending",
      publication: pendingPublication,
      configured: true,
      expected: { pending: true, deliveredAt: null, retryAt: 450, lastError: null },
    },
    {
      status: "retrying",
      publication: {
        ...publicationBase,
        status: "retrying",
        retryAt: 700,
        deliveredAt: null,
        lastError: "completion_callback_not_acknowledged",
      },
      configured: true,
      expected: {
        pending: true,
        deliveredAt: null,
        retryAt: 700,
        lastError: "completion_callback_not_acknowledged",
      },
    },
    {
      status: "delivered",
      publication: {
        ...publicationBase,
        status: "delivered",
        transcriptDelivered: true,
        completionDelivered: true,
        retryAt: null,
        deliveredAt: 800,
        lastError: null,
      },
      configured: true,
      expected: { pending: false, deliveredAt: 800, retryAt: null, lastError: null },
    },
    {
      status: "expired",
      publication: {
        ...publicationBase,
        status: "expired",
        retryAt: null,
        deliveredAt: null,
        lastError: "callback_timed_out",
      },
      configured: true,
      expected: {
        pending: false,
        deliveredAt: null,
        retryAt: null,
        lastError: "callback_timed_out",
      },
    },
    {
      status: "blocked_snapshot_conflict",
      publication: {
        ...publicationBase,
        status: "blocked_snapshot_conflict",
        retryAt: null,
        deliveredAt: null,
        lastError: "snapshot_conflict",
      },
      configured: true,
      expected: {
        pending: false,
        deliveredAt: null,
        retryAt: null,
        lastError: "snapshot_conflict",
      },
    },
    {
      status: "blocked_nonretryable_callback",
      publication: {
        ...publicationBase,
        status: "blocked_nonretryable_callback",
        retryAt: null,
        deliveredAt: null,
        lastError: "callback_rejected",
      },
      configured: true,
      expected: {
        pending: false,
        deliveredAt: null,
        retryAt: null,
        lastError: "callback_rejected",
      },
    },
    {
      status: "unconfigured",
      publication: pendingPublication,
      configured: false,
      expected: { pending: false, deliveredAt: null, retryAt: null, lastError: null },
    },
  ] as const)("projects $status publication delivery", ({ publication, configured, expected }) => {
    const aggregate = aggregateWithState(endedState(publication));

    expect(
      projectInterviewFinalizationPersistence(aggregate, {
        liveDeadlineAt: 900,
        deliveryConfigured: configured,
      }).publicationDelivery,
    ).toEqual(expected);
  });
});

function liveAggregate(): InterviewFinalizationAggregate {
  return liveFinalizationAggregate({ runId: "run_persistence_projection" });
}

function aggregateWithState(
  state: InterviewFinalizationState,
  finalInputQuietDeadline?: number,
): InterviewFinalizationAggregate {
  const aggregate = liveAggregate();
  return {
    ...aggregate,
    // A frozen result seals the aggregate capture.
    transcriptCapture: state.stage === "ended" ? frozenCapture : aggregate.transcriptCapture,
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

function project(aggregate: InterviewFinalizationAggregate) {
  return projectInterviewFinalizationPersistence(aggregate, {
    liveDeadlineAt: 900,
    deliveryConfigured: true,
  });
}

function endedState(publication: RuntimePublicationState): InterviewFinalizationState {
  return { stage: "ended", completion, publication, effects: [] };
}

function capture(itemId: string, text: string): SerializedTranscriptCapture {
  return {
    sequence: 1,
    items: [
      {
        itemId,
        firstSeenSequence: 1,
        role: "participant",
        text,
        finalSequence: 1,
      },
    ],
  };
}
