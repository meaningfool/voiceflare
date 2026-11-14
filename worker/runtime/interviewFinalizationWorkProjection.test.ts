import { describe, expect, it } from "vitest";

import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";

import {
  type FinalizationEffectKind,
  type FinalizationEffectRecord,
  type InterviewFinalizationAggregate,
  type InterviewFinalizationState,
  type RuntimeFinalizationCompletion,
  type RuntimePublicationState,
} from "./interviewFinalizationModel.ts";
import { projectInterviewFinalizationPersistence } from "./interviewFinalizationPersistenceProjection.ts";
import { projectInterviewFinalizationExecution } from "./interviewFinalizationWorkProjection.ts";

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
  runId: "run_execution_projection",
  outcome: "ended",
  endReason: "participant_stopped",
  source: "browser_request",
  endingStartedAt: 100,
  endedAt: 400,
  finalizationCutoffAt: 10_100,
  finalizedAt: 450,
  transcriptSnapshot: { revision: 0, digest: "sha256:empty", turnCount: 0 },
  warnings: [],
} as const satisfies RuntimeFinalizationCompletion;

const pendingPublication = {
  status: "pending",
  publicationCutoffAt: 30_450,
  transcriptDelivered: false,
  completionDelivered: false,
  retryAt: null,
  attemptCount: 0,
  deliveredAt: null,
  lastError: null,
} as const satisfies RuntimePublicationState;

describe("Interview finalization execution projection", () => {
  it("projects both live deadlines, their due state, and the timebox tie-break candidates", () => {
    const view = project(liveAggregate(), {
      now: 200,
      liveDeadlineAt: 200,
      participantPresenceDeadlineAt: 200,
    });

    expect(view.deadlines).toEqual([
      { deadline: "timebox", deadlineAt: 200, observationAt: 200, due: true },
      { deadline: "presence_grace", deadlineAt: 200, observationAt: 200, due: true },
    ]);
    expect(view.nextDomainWakeAt).toBe(200);
    expect(view.arbitrationCandidates.map(({ id }) => id)).toEqual([
      "deadline:timebox",
      "deadline:presence_grace",
    ]);
  });

  it.each([
    {
      name: "the earliest declared timer without a finishing reservation",
      node: conversationNode([timer("later", 700), timer("earlier", 600)]),
      expected: 600,
    },
    {
      name: "the reserved cutoff over an earlier non-closing timer",
      node: reservedConversationNode([timer("other", 650), timer("closing", 800)]),
      expected: 800,
    },
    {
      name: "the reserved cutoff when no timer is declared",
      node: reservedConversationNode([]),
      expected: 800,
    },
  ])("governs a Conversation node by $name", ({ node, expected }) => {
    const aggregate = { ...liveAggregate(), conversationNodeExecution: node };

    const view = project(aggregate, { now: expected, participantPresenceDeadlineAt: null });
    expect(view.deadlines).toEqual([
      { deadline: "timebox", deadlineAt: expected, observationAt: expected, due: true },
    ]);
    expect(view.nodeExecution.expired).toBe(true);
    expect(
      projectInterviewFinalizationPersistence(aggregate, {
        liveDeadlineAt: 900,
        deliveryConfigured: true,
      }).deadlineAt,
    ).toBe(expected);
  });

  it.each([
    {
      stage: "draining",
      state: {
        stage: "draining",
        ...endingState,
        outputAudioActive: false,
      },
      quietDeadline: 250,
      expected: {
        deadline: "drain",
        deadlineAt: 250,
        observationAt: 260,
        due: true,
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
        deadline: "finalization_cutoff",
        deadlineAt: 300,
        observationAt: 260,
        due: false,
      },
    },
    {
      stage: "finalizing",
      state: { stage: "finalizing", ...endingState },
      expected: null,
    },
    {
      stage: "ended",
      state: endedState(),
      expected: null,
    },
  ] as const)("projects the $stage lifecycle deadline", ({ state, quietDeadline, expected }) => {
    const aggregate = aggregateWithState(state, quietDeadline);
    expect(project(aggregate, { now: 260 }).deadlines[0] ?? null).toEqual(expected);
  });

  it("keeps pending effects in durable order and attaches provider requirements", () => {
    const effects = [
      effect("close_input", "close"),
      effect("compute_transcript_digest", "digest"),
      effect("stop_output", "stop"),
      effect("release_session", "wrong-stage"),
      { ...effect("discard_later_input", "done"), status: "dispatched" as const },
    ];
    const aggregate = aggregateWithState({
      stage: "draining",
      ...endingState,
      outputAudioActive: false,
      effects,
    });

    expect(
      project(aggregate, { now: 200 }).effects.map(({ effect: item, requirement }) => [
        item.id,
        requirement,
      ]),
    ).toEqual([
      ["close", "connected_session"],
      ["digest", "provider_free"],
      ["stop", "connected_session"],
    ]);
  });

  it.each([
    {
      stage: "live",
      expected: [
        "compute_transcript_digest",
        "close_input",
        "discard_later_input",
        "cancel_reply",
        "stop_output",
        "arm_alarm",
      ],
    },
    {
      stage: "draining",
      expected: [
        "compute_transcript_digest",
        "close_input",
        "discard_later_input",
        "cancel_reply",
        "stop_output",
        "arm_alarm",
      ],
    },
    {
      stage: "closing_provider",
      expected: [
        "compute_transcript_digest",
        "discard_later_input",
        "cancel_reply",
        "stop_output",
        "release_session",
        "arm_alarm",
      ],
    },
    {
      stage: "finalizing",
      expected: ["compute_transcript_digest", "release_session", "arm_alarm"],
    },
    { stage: "ended", expected: ["release_session"] },
  ] as const)("owns effect eligibility for $stage", ({ stage, expected }) => {
    const allEffects = [
      effect("compute_transcript_digest", "digest"),
      effect("close_input", "close"),
      effect("discard_later_input", "clear-input"),
      effect("cancel_reply", "cancel"),
      effect("stop_output", "clear-output"),
      effect("release_session", "hangup"),
      effect("arm_alarm", "alarm"),
    ];
    const aggregate = aggregateForStage(stage);
    const withEffects = {
      ...aggregate,
      state: { ...aggregate.state, effects: allEffects },
    };

    expect(
      project(withEffects, { now: 200 }).effects.map(({ effect: selected }) => selected.kind),
    ).toEqual(expected);
  });

  it("dispatches provider hangup directly over HTTP", () => {
    const aggregate = aggregateWithState({
      stage: "closing_provider",
      ...endingState,
      outputAudioActive: false,
      effects: [effect("release_session", "hangup")],
    });

    const projected = project(aggregate, { now: 200 });
    expect(projected.effects[0]?.requirement).toBe("session_identity");
    expect(projected.providerConnection.required).toBe(false);
  });

  // The participant's speech before the opening no longer decides a restart (#978, user
  // decision): with nothing else observed, the Run resumes and sends its opening.
  it("resumes an unattempted opening, even after the participant spoke, while preserving reconstruction gaps after conversation activity", () => {
    const waiting = liveAggregate();
    expect(project(waiting, { openingPending: true }).reconstructionRequiresDisconnect).toBe(false);
    expect(project(waiting, { openingPending: false }).reconstructionRequiresDisconnect).toBe(true);
    const speaking = aggregateWithState({
      stage: "live",
      activeInputItemId: "speech",
      activeResponseId: null,
      outputAudioActive: false,
      sessionClosed: false,
      effects: [],
    });
    expect(project(speaking, { openingPending: true }).reconstructionRequiresDisconnect).toBe(
      false,
    );
  });

  // Missed events after a restart during Ending are the Realtime kit's to detect (#978).
  it("reconstructs nothing during Ending and creates no reconnect demand", () => {
    const aggregate = {
      ...aggregateWithState({
        stage: "closing_provider",
        ...endingState,
        outputAudioActive: false,
        effects: [],
      }),
    };

    const execution = project(aggregate, { now: 200 });
    expect(execution.reconstructionRequiresDisconnect).toBe(false);
    expect(execution.providerConnection.required).toBe(false);
  });

  it("never dispatches a pending provider command whose attempt count proves prior work", () => {
    const aggregate = aggregateWithState({
      ...endedState(),
      effects: [{ ...effect("release_session", "hangup"), attemptCount: 1 }],
    });

    expect(project(aggregate, { now: 20_000 }).effects).toEqual([]);
  });

  it("gives an application closing one result cutoff without a second provider-close deadline", () => {
    const applicationTranscriptProof = {
      liveAt: 50,
      interrupted: false,
      completedReason: "participant_stopped" as const,
      obligations: [],
      closeBarrier: null,
      result: null,
    };
    const closing = {
      ...aggregateWithState({
        stage: "closing_provider",
        ...endingState,
        outputAudioActive: false,
        effects: [effect("release_session", "hangup")],
      }),
      applicationTranscriptProof,
    };
    expect(project(closing, { now: 200 }).deadlines.map(({ deadline }) => deadline)).toEqual([
      "finalization_cutoff",
    ]);
  });

  it("lets an overdue cutoff outrank never-started hard-stop entry effects", () => {
    const aggregate = aggregateWithState({
      stage: "draining",
      ...endingState,
      // The cutoff coincides with the drain checkpoint, endingStartedAt + 9s.
      finalizationCutoffAt: 9_100,
      outputAudioActive: false,
      effects: [effect("close_input", "close")],
    });

    const beforeAttempt = project(aggregate, { now: 9_200 });
    expect(beforeAttempt.deadlines[0]?.due).toBe(true);
    expect(beforeAttempt.arbitrationCandidates.map(({ id }) => id)).toEqual([
      "deadline:drain",
      "deadline:finalization_cutoff",
      "effect:close",
    ]);

    const afterAttempt = project(
      {
        ...aggregate,
        state: {
          ...aggregate.state,
          effects: [{ ...effect("close_input", "close"), attemptCount: 1 }],
        },
      },
      { now: 9_200 },
    );
    expect(afterAttempt.arbitrationCandidates.map(({ id }) => id)).toEqual([
      "deadline:drain",
      "deadline:finalization_cutoff",
    ]);
  });

  it.each([
    { stage: "live", now: 200, expected: true, untilAt: 400 },
    { stage: "live", now: 400, expected: false, untilAt: 400 },
    // Draining holds the provider until the drain checkpoint, endingStartedAt + 9s.
    { stage: "draining", now: 200, expected: false, untilAt: 9_100 },
    { stage: "draining", now: 9_100, expected: false, untilAt: 9_100 },
    { stage: "closing_provider", now: 200, expected: false, untilAt: 300 },
    { stage: "closing_provider", now: 300, expected: false, untilAt: 300 },
    { stage: "finalizing", now: 200, expected: false, untilAt: null },
    { stage: "ended", now: 500, expected: false, untilAt: null },
  ] as const)("projects provider connection demand for $stage at $now", (example) => {
    const aggregate = aggregateForStage(example.stage);
    expect(
      project(aggregate, {
        now: example.now,
        liveDeadlineAt: 500,
        participantPresenceDeadlineAt: 400,
      }).providerConnection,
    ).toMatchObject({
      required: example.expected,
      untilAt: example.untilAt,
    });
  });

  it("suppresses provider connection demand after provider-confirmed close", () => {
    const aggregate = aggregateWithState({
      stage: "closing_provider",
      ...endingState,
      sessionClosed: true,
      outputAudioActive: false,
    });
    expect(project(aggregate, { now: 200 }).providerConnection.required).toBe(false);
  });

  it("exposes publication only after completion and at its retry readiness time", () => {
    const finalizing = aggregateForStage("finalizing");
    expect(project(finalizing, { now: 1_000 }).publication).toEqual({
      requested: false,
      ready: false,
      readyAt: null,
      work: null,
    });
    const ended = aggregateWithState(
      endedState({ ...pendingPublication, status: "retrying", retryAt: 700, lastError: "retry" }),
    );
    expect(project(ended, { now: 699 }).publication).toMatchObject({
      requested: true,
      ready: false,
      readyAt: 700,
      work: null,
    });
    expect(project(ended, { now: 700 }).publication).toMatchObject({
      requested: true,
      ready: true,
      readyAt: 700,
      work: { id: "publication", kind: "publication" },
    });
  });

  it.each([
    { status: "pending", publication: pendingPublication, readyAt: 450, requested: true },
    {
      status: "retrying",
      publication: { ...pendingPublication, status: "retrying", retryAt: 700, lastError: "retry" },
      readyAt: 700,
      requested: true,
    },
    {
      status: "retrying",
      publication: { ...pendingPublication, status: "retrying", lastError: "retry" },
      readyAt: 30_450,
      requested: true,
    },
    {
      status: "expired",
      publication: { ...pendingPublication, status: "expired" },
      readyAt: null,
      requested: false,
    },
    {
      status: "delivered",
      publication: {
        ...pendingPublication,
        status: "delivered",
        transcriptDelivered: true,
        completionDelivered: true,
        deliveredAt: 480,
      },
      readyAt: null,
      requested: false,
    },
    {
      status: "blocked_snapshot_conflict",
      publication: {
        ...pendingPublication,
        status: "blocked_snapshot_conflict",
        lastError: "snapshot_conflict",
      },
      readyAt: null,
      requested: false,
    },
    {
      status: "blocked_nonretryable_callback",
      publication: {
        ...pendingPublication,
        status: "blocked_nonretryable_callback",
        lastError: "callback_rejected",
      },
      readyAt: null,
      requested: false,
    },
  ] as const)("projects $status terminal publication demand", (example) => {
    const withPublication = aggregateWithState(endedState(example.publication));
    expect(project(withPublication, { now: 500 }).publication).toMatchObject({
      requested: example.requested,
      readyAt: example.readyAt,
    });
  });
});

function liveAggregate(): InterviewFinalizationAggregate {
  return liveFinalizationAggregate({ runId: "run_execution_projection" });
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
            effectId: "final-input",
            obligation: "awaiting_transcription",
            admittedItemId: "input",
            inputToSettle: true,
            answerFollows: false,
            quietDeadline: finalInputQuietDeadline,
            duplicateCount: 0,
            warning: null,
          },
  };
}

function aggregateForStage(
  stage: InterviewFinalizationState["stage"],
): InterviewFinalizationAggregate {
  switch (stage) {
    case "live":
      return liveAggregate();
    case "draining":
      return aggregateWithState({
        stage,
        ...endingState,
        outputAudioActive: false,
      });
    case "closing_provider":
      return aggregateWithState({
        stage,
        ...endingState,
        outputAudioActive: false,
      });
    case "finalizing":
      return aggregateWithState({ stage, ...endingState });
    case "ended":
      return aggregateWithState(endedState());
    default:
      return assertUnreachable(stage);
  }
}

type ConversationNodeExecution = NonNullable<
  InterviewFinalizationAggregate["conversationNodeExecution"]
>;

function timer(id: string, deadlineAt: number) {
  return { id, deadlineAt, event: { kind: "time_elapsed" } };
}

function conversationNode(timers: ConversationNodeExecution["timers"]): ConversationNodeExecution {
  return {
    kind: "ordinary",
    mediaCutoffAt: 800,
    timers,
    dispatch: { input: {}, status: "pending" },
  };
}

function reservedConversationNode(
  timers: ConversationNodeExecution["timers"],
): ConversationNodeExecution {
  return {
    kind: "finishing",
    mediaCutoffAt: 800,
    timers,
    dispatch: { input: {}, status: "pending" },
    reservation: { reason: "agent_requested_end", source: "agent_completion", at: 250 },
    closingCutoffAt: 800,
  };
}

function effect(kind: FinalizationEffectKind, id: string): FinalizationEffectRecord {
  const fields = { id, status: "pending", acceptance: "unobserved", attemptCount: 0 } as const;
  switch (kind) {
    case "compute_transcript_digest":
      return { ...fields, kind, revision: 0 };
    case "cancel_reply":
      return { ...fields, kind, responseId: "response" };
    case "close_input":
      return { ...fields, kind, heldItemId: null };
    default:
      return { ...fields, kind };
  }
}

function endedState(
  publication: RuntimePublicationState = pendingPublication,
): Extract<InterviewFinalizationState, { stage: "ended" }> {
  return { stage: "ended", completion, publication, effects: [] };
}

function project(
  aggregate: InterviewFinalizationAggregate,
  overrides: Partial<Parameters<typeof projectInterviewFinalizationExecution>[1]> = {},
) {
  return projectInterviewFinalizationExecution(aggregate, {
    now: 200,
    liveDeadlineAt: 500,
    participantPresenceDeadlineAt: 400,
    ...overrides,
  });
}

function assertUnreachable(value: never): never {
  throw new Error(`Unexpected stage: ${JSON.stringify(value)}`);
}
