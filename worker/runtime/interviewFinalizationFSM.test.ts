import { describe, expect, it, vi } from "vitest";

import { advanceInterviewFinalization } from "./interviewFinalizationFSM.ts";
import {
  liveFinalizationAggregate,
  receiveConversationReceipt,
} from "./testing/finalizationFixtures.ts";
import {
  stateWarnings,
  type FinalizationEffectRecord,
  type FinalizationInput,
  type InterviewFinalizationAggregate,
} from "./interviewFinalizationModel.ts";
import { isInterviewFinalizationAggregate } from "./interviewFinalizationPersistenceDecoder.ts";

function liveAggregate(): InterviewFinalizationAggregate {
  return liveFinalizationAggregate({ runId: "run_250" });
}

function settleFinalInputCommit(
  aggregate: InterviewFinalizationAggregate,
): InterviewFinalizationAggregate {
  const commit = aggregate.state.effects.find((effect) => effect.kind === "close_input");
  if (commit === undefined) throw new Error("Expected final input commit effect.");
  return advanceInterviewFinalization(aggregate, {
    kind: "effect_outcome",
    effectId: commit.id,
    outcome: { status: "dispatched" },
    at: 100,
  }).aggregate;
}

type EndingCoverageStage =
  | "draining_input_open"
  | "draining_input_settled"
  | "closing_provider"
  | "finalizing";

/** The usage an execution reports with a participant item: its transcription is expected. */
function expectedTranscription(itemId: string) {
  return [
    { status: "expected", componentRole: "speech_to_text", key: `speech_to_text:${itemId}` },
  ] as const;
}

/** A transcription that settled without a usage account. */
function unknownTranscription(itemId: string) {
  return [
    {
      status: "unavailable",
      componentRole: "speech_to_text",
      key: `speech_to_text:${itemId}:unknown`,
      pendingKey: `speech_to_text:${itemId}`,
    },
  ] as const;
}

function endingAggregateAtStage(
  firstTrigger: FinalizationInput,
  targetStage: EndingCoverageStage,
): InterviewFinalizationAggregate {
  let aggregate = advanceInterviewFinalization(liveAggregate(), firstTrigger).aggregate;
  if (targetStage === "draining_input_open") return aggregate;

  const commit = aggregate.state.effects.find(({ kind }) => kind === "close_input");
  if (commit === undefined) throw new Error("Expected final input commit effect.");
  aggregate = advanceInterviewFinalization(aggregate, {
    kind: "effect_outcome",
    effectId: commit.id,
    outcome: { status: "dispatched" },
    at: 101,
  }).aggregate;
  aggregate = advanceInterviewFinalization(aggregate, {
    kind: "participant_answer_created",
    itemId: "coverage_final_input",
    generation: 1,
    sequence: 1,
    usage: expectedTranscription("coverage_final_input"),
  }).aggregate;
  if (targetStage === "draining_input_settled")
    return advanceInterviewFinalization(aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "coverage_final_input",
      text: "Coverage final input.",
      generation: 1,
      sequence: 2,
      usage: unknownTranscription("coverage_final_input"),
    }).aggregate;

  // The nine-second checkpoint begins provider cleanup only while evidence is still owed.

  aggregate = advanceInterviewFinalization(aggregate, {
    kind: "deadline_reached",
    deadline: "drain",
    at: 9_100,
  }).aggregate;
  if (targetStage === "closing_provider") return aggregate;

  // The owed transcription settles before the cutoff, so the result freezes early.
  aggregate = advanceInterviewFinalization(aggregate, {
    kind: "participant_answer_transcribed",
    itemId: "coverage_final_input",
    text: "Coverage final input.",
    generation: 1,
    sequence: 2,
    observedAt: 9_200,
    usage: unknownTranscription("coverage_final_input"),
  }).aggregate;
  if (aggregate.state.stage !== "finalizing") {
    throw new Error(`Expected finalizing state, received ${aggregate.state.stage}.`);
  }
  return aggregate;
}

type ObservationKind = FinalizationInput["kind"];

type ObservationByKind = {
  readonly [Kind in ObservationKind]: Extract<FinalizationInput, { kind: Kind }>;
};

const endedObservations = {
  conversation_evidence_observed: {
    kind: "conversation_evidence_observed",
    usageEvidence: [],
    snapshot: liveFinalizationAggregate({ runId: "late" }),
    effects: [],
    at: 300,
    notification: "none",
  },
  evidence_prefix_processed: { kind: "evidence_prefix_processed", at: 300 },
  session_activity_observed: {
    kind: "session_activity_observed",
    generation: 1,
    sequence: 4,
    at: 300,
  },
  end_requested: {
    kind: "end_requested",
    reason: "participant_stopped",
    source: "late_browser_request",
    at: 300,
  },
  runtime_failure_observed: {
    kind: "runtime_failure_observed",
    source: "late_runtime_failure",
    at: 300,
  },
  transcript_item_observed: {
    kind: "transcript_item_observed",
    itemId: "late_transcript_item",
    generation: 1,
    sequence: 4,
  },
  participant_answer_created: {
    kind: "participant_answer_created",
    itemId: "late_input_item",
    generation: 1,
    sequence: 4,
  },
  participant_answer_transcribed: {
    kind: "participant_answer_transcribed",
    itemId: "late_input_item",
    text: "must remain ignored",
    generation: 1,
    sequence: 4,
  },
  participant_answer_transcription_failed: {
    kind: "participant_answer_transcription_failed",
    itemId: "late_input_item",
    code: "late_failure",
    generation: 1,
    sequence: 4,
  },
  agent_transcript_finalized: {
    kind: "agent_transcript_finalized",
    itemId: "late_assistant_item",
    responseId: "late_response",
    text: "must remain ignored",
    generation: 1,
    sequence: 4,
  },
  reply_started: {
    kind: "reply_started",
    responseId: "late_response",
    generation: 1,
    sequence: 4,
  },
  reply_generated: {
    kind: "reply_generated",
    responseId: "late_response",
    generation: 1,
    sequence: 4,
  },
  reply_cancelled: {
    kind: "reply_cancelled",
    responseId: "late_response",
    generation: 1,
    sequence: 4,
  },
  reply_delivery_started: {
    kind: "reply_delivery_started",
    responseId: "late_response",
    generation: 1,
    sequence: 4,
  },
  reply_delivery_stopped: {
    kind: "reply_delivery_stopped",
    responseId: "late_response",
    generation: 1,
    sequence: 4,
  },
  session_error_observed: {
    kind: "session_error_observed",
    eventId: "late_effect",
    code: "late_error",
    generation: 1,
    sequence: 4,
  },
  nothing_to_settle: {
    kind: "nothing_to_settle",
    commandId: "late_effect",
    generation: 1,
    sequence: 4,
  },
  nothing_to_cancel: {
    kind: "nothing_to_cancel",
    commandId: "late_effect",
    generation: 1,
    sequence: 4,
  },
  session_closed_observed: {
    kind: "session_closed_observed",
    generation: 1,
    sequence: 4,
    at: 300,
  },
  effect_outcome: {
    kind: "effect_outcome",
    effectId: "late_effect",
    outcome: { status: "dispatched" },
    at: 300,
  },
  interrupted_effects_recovered: {
    kind: "interrupted_effects_recovered",
  },
  transcript_digest_computed: {
    kind: "transcript_digest_computed",
    revision: 999,
    digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    at: 300,
  },
  deadline_reached: {
    kind: "deadline_reached",
    deadline: "finalization_cutoff",
    at: 300,
  },
  execution_warning_attached: {
    kind: "execution_warning_attached",
    warning: "provider_observation_gap",
    at: 300,
  },
} as const satisfies ObservationByKind;

function endedAggregate(): InterviewFinalizationAggregate {
  const finalizing = endingAggregateAtStage(
    {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    },
    "finalizing",
  );
  const ended = advanceInterviewFinalization(finalizing, {
    kind: "transcript_digest_computed",
    revision: finalizing.transcriptRevision,
    digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    at: 200,
  }).aggregate;
  if (ended.state.stage !== "ended") {
    throw new Error(`Expected ended state, received ${ended.state.stage}.`);
  }
  return ended;
}

function closingProviderAggregate(): InterviewFinalizationAggregate {
  const aggregate = endingAggregateAtStage(
    {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    },
    "closing_provider",
  );
  if (aggregate.state.stage !== "closing_provider") {
    throw new Error(`Expected closing_provider state, received ${aggregate.state.stage}.`);
  }
  return aggregate;
}

describe("Interview finalization state machine", () => {
  it.each([
    ["draining_input_settled", 10_001],
    ["closing_provider", 10_000],
  ] as const)("preserves terminal-close completion time in %s", (stage, finalizedAt) => {
    const ending = endingAggregateAtStage(
      { kind: "end_requested", reason: "participant_stopped", source: "browser_request", at: 100 },
      stage,
    );
    // Provider cleanup began while the final transcription was owed; it has since settled.
    const settled =
      stage === "closing_provider"
        ? advanceInterviewFinalization(ending, {
            kind: "participant_answer_transcribed",
            itemId: "coverage_final_input",
            text: "Coverage final input.",
            generation: 1,
            sequence: 2,
          }).aggregate
        : ending;
    const aggregate = {
      ...settled,
      transcriptDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const decision = advanceInterviewFinalization(aggregate, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 3,
      at: 10_000,
      observedAt: 10_001,
    });

    expect(decision.aggregate.state.stage).toBe("ended");
    if (decision.aggregate.state.stage !== "ended") throw new Error("Expected ended state.");
    expect(decision.aggregate.state.completion).toEqual({
      runId: "run_250",
      outcome: "ended",
      endReason: "participant_stopped",
      source: "browser_request",
      endingStartedAt: 100,
      endedAt: 100,
      finalizationCutoffAt: 10_100,
      finalizedAt,
      transcriptSnapshot: {
        revision: 1,
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        turnCount: 1,
      },
      warnings: [],
    });
  });

  it.each([
    {
      label: "participant stop",
      observation: {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 1_000,
      },
    },
    {
      label: "timebox",
      observation: { kind: "deadline_reached", deadline: "timebox", at: 1_000 },
    },
    {
      label: "continuity loss",
      observation: { kind: "deadline_reached", deadline: "presence_grace", at: 1_000 },
    },
    {
      label: "runtime failure",
      observation: { kind: "runtime_failure_observed", source: "runtime", at: 1_000 },
    },
  ] satisfies readonly { label: string; observation: FinalizationInput }[])(
    "persists one ten-second result cutoff for $label",
    ({ observation }) => {
      const decision = advanceInterviewFinalization(liveAggregate(), observation);
      expect(decision.aggregate.state).toMatchObject({
        endingStartedAt: 1_000,
        finalizationCutoffAt: 11_000,
      });
    },
  );

  it.each([
    ["timebox", "timebox_reached", "timebox_alarm"],
    ["presence_grace", "participant_disconnected", "presence_timeout"],
  ] as const)(
    "routes a persisted %s deadline through the hard-stop transition",
    (deadline, endReason, source) => {
      const decision = advanceInterviewFinalization(liveAggregate(), {
        kind: "deadline_reached",
        deadline,
        at: 1_700_000_015_000,
      });

      expect(decision.aggregate.state).toMatchObject({
        stage: "draining",
        endReason,
        source,
        strategy: "hard_stop",
        endingStartedAt: 1_700_000_015_000,
      });
      expect(decision.effects.map((effect) => effect.kind)).toEqual([
        "close_input",
        "stop_output",
        "arm_alarm",
      ]);
    },
  );

  it("preserves the first deadline trigger across repeats and conflicts", () => {
    const timebox = advanceInterviewFinalization(liveAggregate(), {
      kind: "deadline_reached",
      deadline: "timebox",
      at: 100,
    });
    const repeated = advanceInterviewFinalization(timebox.aggregate, {
      kind: "deadline_reached",
      deadline: "timebox",
      at: 101,
    });
    const conflicting = advanceInterviewFinalization(repeated.aggregate, {
      kind: "deadline_reached",
      deadline: "presence_grace",
      at: 99,
    });

    expect(conflicting.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "timebox_reached",
      source: "timebox_alarm",
      endingStartedAt: 100,
    });
    expect(repeated.effects).toEqual([]);
    expect(conflicting.effects).toEqual([]);
  });

  it("deduplicates matching hard-stop deadlines and ignores conflicts in every ending stage", () => {
    const stages: readonly EndingCoverageStage[] = [
      "draining_input_open",
      "draining_input_settled",
      "closing_provider",
      "finalizing",
    ];
    for (const deadline of ["timebox", "presence_grace"] as const) {
      for (const stage of stages) {
        const aggregate = endingAggregateAtStage(
          { kind: "deadline_reached", deadline, at: 100 },
          stage,
        );
        const repeated = advanceInterviewFinalization(aggregate, {
          kind: "deadline_reached",
          deadline,
          at: 200,
        });
        const conflicting = advanceInterviewFinalization(aggregate, {
          kind: "deadline_reached",
          deadline: deadline === "timebox" ? "presence_grace" : "timebox",
          at: 200,
        });

        expect(repeated.aggregate, `${deadline}:${stage}:repeat`).toEqual(aggregate);
        expect(repeated.effects, `${deadline}:${stage}:repeat effects`).toEqual([]);
        expect(repeated.events, `${deadline}:${stage}:repeat events`).toEqual([]);
        expect(conflicting.aggregate, `${deadline}:${stage}:conflict`).toEqual(aggregate);
        expect(conflicting.effects, `${deadline}:${stage}:conflict effects`).toEqual([]);
        expect(conflicting.events, `${deadline}:${stage}:conflict events`).toEqual([]);
      }
    }
  });

  it("hard-stops active assistant output when the timebox expires", () => {
    const active = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_at_timebox",
      generation: 1,
      sequence: 1,
    });
    const ending = advanceInterviewFinalization(active.aggregate, {
      kind: "deadline_reached",
      deadline: "timebox",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });

    expect(ending.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "timebox_reached",
      strategy: "hard_stop",
      activeResponseId: "response_at_timebox",
    });
    expect(closing.aggregate.state).toMatchObject({ stage: "closing_provider" });
    expect(closing.effects.map(({ kind }) => kind)).toEqual([
      "discard_later_input",
      "release_session",
    ]);
  });

  it("preserves Runtime failure semantics before and after another trigger", () => {
    const first = advanceInterviewFinalization(liveAggregate(), {
      kind: "runtime_failure_observed",
      source: "session_failure",
      at: 99,
    });
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "deadline_reached",
      deadline: "presence_grace",
      at: 100,
    });
    const failed = advanceInterviewFinalization(ending.aggregate, {
      kind: "runtime_failure_observed",
      source: "session_failure",
      at: 101,
    });
    const repeated = advanceInterviewFinalization(failed.aggregate, {
      kind: "runtime_failure_observed",
      source: "session_failure",
      at: 102,
    });

    expect(first.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "runtime_failed",
      source: "session_failure",
      warnings: [],
    });
    expect(repeated.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "participant_disconnected",
      source: "presence_timeout",
      endingStartedAt: 100,
      warnings: ["runtime_failed_during_finalization"],
    });
  });

  it("uses a post-live Runtime failure as the first hard-stop trigger", () => {
    const decision = advanceInterviewFinalization(liveAggregate(), {
      kind: "runtime_failure_observed",
      source: "session_failure",
      at: 100,
    });

    expect(decision.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "runtime_failed",
      source: "session_failure",
      strategy: "hard_stop",
      endingStartedAt: 100,
    });
  });

  it("deduplicates repeated Runtime failure in every ending stage", () => {
    for (const stage of [
      "draining_input_open",
      "draining_input_settled",
      "closing_provider",
      "finalizing",
    ] as const) {
      const aggregate = endingAggregateAtStage(
        {
          kind: "runtime_failure_observed",
          source: "session_failure",
          at: 100,
        },
        stage,
      );
      const repeated = advanceInterviewFinalization(aggregate, {
        kind: "runtime_failure_observed",
        source: "session_failure",
        at: 200,
      });

      expect(repeated.aggregate, stage).toEqual(aggregate);
      expect(repeated.effects, stage).toEqual([]);
      expect(repeated.events, stage).toEqual([]);
    }
  });

  it("contains Runtime failure after another trigger in every ending stage", () => {
    for (const stage of [
      "draining_input_open",
      "draining_input_settled",
      "closing_provider",
      "finalizing",
    ] as const) {
      const aggregate = endingAggregateAtStage(
        { kind: "deadline_reached", deadline: "presence_grace", at: 100 },
        stage,
      );
      const failed = advanceInterviewFinalization(aggregate, {
        kind: "runtime_failure_observed",
        source: "session_failure",
        at: 200,
      });

      if (failed.aggregate.state.stage === "live" || failed.aggregate.state.stage === "ended") {
        throw new Error(`Expected active finalization state for ${stage}.`);
      }
      expect(failed.aggregate.state.endReason, stage).toBe("participant_disconnected");
      expect(failed.aggregate.state.warnings, stage).toContain(
        "runtime_failed_during_finalization",
      );
      expect(failed.effects, stage).toEqual([]);
      expect(failed.events, stage).toEqual([]);
    }
  });

  it("rejects an unknown end reason in persisted Runtime finalization state", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "deadline_reached",
      deadline: "timebox",
      at: 100,
    }).aggregate;
    if (ending.state.stage !== "draining") throw new Error("Expected draining state.");

    expect(
      isInterviewFinalizationAggregate({
        ...ending,
        state: { ...ending.state, endReason: "future_reason" },
      }),
    ).toBe(false);
  });

  // A warning is Runtime's own or one its execution declares; the stored state checks its shape.
  it("rejects a malformed warning at the persisted aggregate boundary", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    }).aggregate;
    if (ending.state.stage !== "draining") throw new Error("Expected draining state.");

    expect(
      isInterviewFinalizationAggregate({
        ...ending,
        state: { ...ending.state, warnings: ["Events may be missing"] },
      }),
    ).toBe(false);
  });

  it("validates persisted graceful response identity and settlement state", () => {
    const graceful = receiveConversationReceipt(liveAggregate(), {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      responseStatus: "completed",
      generation: 1,
      sequence: 1,
      at: 100,
    }).aggregate;

    expect(isInterviewFinalizationAggregate(graceful)).toBe(true);
    expect(
      isInterviewFinalizationAggregate({
        ...graceful,
        providerResponses: [...graceful.providerResponses, ...graceful.providerResponses],
      }),
    ).toBe(false);
    expect(
      isInterviewFinalizationAggregate({
        ...graceful,
        gracefulCompletion: {
          ...graceful.gracefulCompletion,
          responseId: "response_inferred_from_latest",
        },
      }),
    ).toBe(false);
  });

  it("accepts the first live end request as asynchronous draining", () => {
    const aggregate = liveAggregate();
    const decision = advanceInterviewFinalization(aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 1_700_000_010_000,
    });

    const effects = [
      {
        id: "run_250:1",
        kind: "close_input",
        status: "pending",
        acceptance: "unobserved",
        attemptCount: 0,
        heldItemId: null,
      },
      {
        id: "run_250:2",
        kind: "stop_output",
        status: "pending",
        acceptance: "unobserved",
        attemptCount: 0,
      },
      {
        id: "run_250:3",
        kind: "arm_alarm",
        status: "pending",
        acceptance: "unobserved",
        attemptCount: 0,
      },
    ] as const;
    const events = [
      {
        id: "run_250:event:1",
        type: "runtime.ending",
        payload: {
          endReason: "participant_stopped",
          source: "browser_request",
          strategy: "hard_stop",
          drainDeadline: 1_700_000_019_000,
          finalizationCutoffAt: 1_700_000_020_000,
        },
      },
    ] as const;

    expect(decision).toEqual({
      aggregate: {
        ...aggregate,
        state: {
          stage: "draining",
          endReason: "participant_stopped",
          source: "browser_request",
          strategy: "hard_stop",
          endingStartedAt: 1_700_000_010_000,
          finalizationCutoffAt: 1_700_000_020_000,
          activeInputItemId: null,
          admittedResponseId: null,
          activeResponseId: null,
          outputAudioActive: false,
          sessionClosed: false,
          effects,
          warnings: [],
        },
        applicationTranscriptProof: {
          ...aggregate.applicationTranscriptProof,
          completedReason: "participant_stopped",
        },
        finalInput: {
          admissionCutoffAt: 1_700_000_010_000,
          fence: { generation: 0, sequence: 0 },
          effectId: "run_250:1",
          obligation: "awaiting_item",
          admittedItemId: null,
          inputToSettle: false,
          answerFollows: false,
          settledByTerminalObservation: false,
          quietDeadline: 1_700_000_011_000,
          duplicateCount: 0,
          warning: null,
        },
        nextEffectSequence: 4,
        nextEventSequence: 2,
      },
      effects,
      events,
    });
  });

  it("preserves optional property presence and insertion order at the public seam", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const firstEffect = ending.effects[0];
    if (firstEffect === undefined) throw new Error("Expected a finalization effect.");

    expect(Object.keys(firstEffect)).toEqual([
      "id",
      "kind",
      "status",
      "acceptance",
      "attemptCount",
      "heldItemId",
    ]);
    expect(ending.aggregate.state).not.toHaveProperty("providerCloseBarrier");

    const transcriptItem = advanceInterviewFinalization(liveAggregate(), {
      kind: "transcript_item_observed",
      itemId: "ordered_item",
      previousItemId: "previous_item",
      role: "conversationAgent",
      responseId: "response_ordered",
      outputIndex: 2,
      contentIndex: 3,
      generation: 1,
      sequence: 1,
    }).aggregate.transcriptCapture.items[0];
    if (transcriptItem === undefined) throw new Error("Expected a Transcript item.");

    expect(Object.keys(transcriptItem)).toEqual([
      "itemId",
      "firstSeenSequence",
      "previousItemId",
      "role",
      "responseId",
      "outputIndex",
      "contentIndex",
      "finalSequence",
    ]);

    const providerClosed = advanceInterviewFinalization(liveAggregate(), {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 1,
      at: 101,
    });
    expect(Object.keys(providerClosed.aggregate.state)).toEqual([
      "stage",
      "endReason",
      "source",
      "strategy",
      "endingStartedAt",
      "finalizationCutoffAt",
      "activeInputItemId",
      "admittedResponseId",
      "activeResponseId",
      "outputAudioActive",
      "sessionClosed",
      "providerCloseBarrier",
      "effects",
      "warnings",
    ]);
    if (providerClosed.aggregate.state.stage !== "draining") {
      throw new Error("Expected provider closure to enter draining.");
    }
    expect(Object.keys(providerClosed.aggregate.state.providerCloseBarrier ?? {})).toEqual([
      "generation",
      "sequence",
    ]);
  });

  it("preserves the exact admitted final-speech settlement while draining", () => {
    vi.useFakeTimers();
    vi.setSystemTime(707);
    try {
      const active = advanceInterviewFinalization(liveAggregate(), {
        kind: "session_activity_observed",
        generation: 1,
        sequence: 1,
        at: 90,
      });
      const ending = advanceInterviewFinalization(active.aggregate, {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      });
      const committed = settleFinalInputCommit(ending.aggregate);

      const admitted = advanceInterviewFinalization(committed, {
        kind: "participant_answer_created",
        itemId: "final_speech",
        generation: 1,
        sequence: 2,
        usage: expectedTranscription("final_speech"),
      });
      expect(admitted).toEqual({
        aggregate: {
          ...committed,
          nextProviderSequence: 3,
          acceptedProviderOrder: { generation: 1, sequence: 2 },
          state: {
            ...committed.state,
            activeInputItemId: "final_speech",
          },
          applicationTranscriptProof: {
            ...committed.applicationTranscriptProof,
            inventoriedResponseIds: [],
            obligations: [
              {
                itemId: "final_speech",
                role: "participant",
                status: "pending",
              },
            ],
          },
          runtimeUsage: {
            ...committed.runtimeUsage,
            pending: [
              {
                componentRole: "speech_to_text",
                key: "speech_to_text:final_speech",
              },
            ],
          },
          finalInput: {
            ...committed.finalInput,
            obligation: "awaiting_transcription",
            admittedItemId: "final_speech",
            settledByTerminalObservation: false,
            quietDeadline: 1_707,
          },
        },
        effects: [],
        events: [],
      });

      const settled = advanceInterviewFinalization(admitted.aggregate, {
        kind: "participant_answer_transcribed",
        itemId: "final_speech",
        text: "  exact final answer\n",
        generation: 1,
        sequence: 3,
      });
      expect(settled.aggregate.transcriptCapture).toEqual({
        sequence: 1,
        items: [
          {
            itemId: "final_speech",
            firstSeenSequence: 1,
            role: "participant",
            text: "  exact final answer\n",
            finalSequence: 1,
          },
        ],
      });
      expect(settled.aggregate.finalInput).toMatchObject({
        obligation: "settled",
        admittedItemId: "final_speech",
        settledByTerminalObservation: true,
      });
      // Settled evidence lets the result freeze before the cutoff.
      expect(settled.aggregate.state.stage).toBe("finalizing");
      expect(settled.effects.map(({ kind }) => kind)).toEqual([
        "release_session",
        "compute_transcript_digest",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves exact provider transcript-item association while draining", () => {
    const active = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_closing",
      generation: 1,
      sequence: 1,
    });
    const aggregate = receiveConversationReceipt(active.aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      generation: 1,
      sequence: 2,
      at: 100,
    }).aggregate;

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "transcript_item_observed",
        itemId: "item_closing",
        role: "conversationAgent",
        responseId: "response_closing",
        generation: 1,
        sequence: 3,
      }),
    ).toEqual({
      aggregate: {
        ...aggregate,
        nextProviderSequence: 4,
        acceptedProviderOrder: { generation: 1, sequence: 3 },
        applicationTranscriptProof: {
          ...aggregate.applicationTranscriptProof,
          inventoriedResponseIds: [],
          obligations: [
            {
              itemId: "item_closing",
              role: "conversationAgent",
              status: "pending",
            },
          ],
        },
        transcriptCapture: {
          sequence: 1,
          items: [
            {
              itemId: "item_closing",
              firstSeenSequence: 1,
              role: "conversationAgent",
              responseId: "response_closing",
              finalSequence: 1,
            },
          ],
        },
      },
      effects: [],
      events: [],
    });
  });

  it("preserves exact rejected-finish response settlement while draining", () => {
    const active = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_rejected_finish",
      generation: 1,
      sequence: 1,
    });
    const aggregate = advanceInterviewFinalization(active.aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    }).aggregate;

    expect(
      receiveConversationReceipt(aggregate, {
        kind: "provider_finish_interview_rejected",
        responseId: "response_rejected_finish",
        responseStatus: "failed",
        missingIdentities: ["callId"],
        generation: 1,
        sequence: 2,
      }),
    ).toEqual({
      aggregate: {
        ...aggregate,
        nextProviderSequence: 3,
        acceptedProviderOrder: { generation: 1, sequence: 2 },
        providerResponses: [
          {
            responseId: "response_rejected_finish",
            status: "failed",
            outputAudio: "pending",
          },
        ],
        state: {
          ...aggregate.state,
          activeResponseId: null,
        },
      },
      effects: [],
      events: [],
    });
  });

  it("preserves the exact hard-stop containment decision during active audio", () => {
    const activeResponse = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_active_at_stop",
      generation: 1,
      sequence: 1,
    });
    const activeAudio = advanceInterviewFinalization(activeResponse.aggregate, {
      kind: "reply_delivery_started",
      responseId: "response_active_at_stop",
      generation: 1,
      sequence: 2,
    });
    const ending = advanceInterviewFinalization(activeAudio.aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    if (ending.aggregate.state.stage !== "draining" || ending.aggregate.finalInput === null) {
      throw new Error("Expected hard-stop draining state.");
    }
    expect(ending.effects.map(({ kind }) => kind)).toEqual([
      "close_input",
      "cancel_reply",
      "stop_output",
      "arm_alarm",
    ]);
    const effects = [
      {
        id: "run_250:5",
        kind: "discard_later_input" as const,
        status: "pending" as const,
        acceptance: "unobserved" as const,
        attemptCount: 0,
      },
      {
        id: "run_250:6",
        kind: "release_session" as const,
        status: "pending" as const,
        acceptance: "unobserved" as const,
        attemptCount: 0,
      },
    ];

    expect(
      advanceInterviewFinalization(ending.aggregate, {
        kind: "deadline_reached",
        deadline: "drain",
        at: 9_100,
      }),
    ).toEqual({
      aggregate: {
        ...ending.aggregate,
        nextEffectSequence: 7,
        state: {
          ...ending.aggregate.state,
          stage: "closing_provider",
          effects: [...ending.aggregate.state.effects, ...effects],
          warnings: [],
        },
      },
      effects,
      events: [],
    });
  });

  it("preserves the exact admitted-transcription drain timeout and warning order", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const committed = settleFinalInputCommit(ending.aggregate);
    const aggregate = advanceInterviewFinalization(committed, {
      kind: "participant_answer_created",
      itemId: "pending_transcription",
      generation: 1,
      sequence: 1,
    }).aggregate;
    if (aggregate.state.stage !== "draining" || aggregate.finalInput === null) {
      throw new Error("Expected draining input obligation.");
    }
    const effects = [
      {
        id: "run_250:4",
        kind: "release_session" as const,
        status: "pending" as const,
        acceptance: "unobserved" as const,
        attemptCount: 0,
      },
      {
        id: "run_250:5",
        kind: "compute_transcript_digest" as const,
        status: "pending" as const,
        acceptance: "unobserved" as const,
        attemptCount: 0,
        revision: 0,
      },
    ];
    const { outputAudioActive: _outputAudioActive, ...endingFacts } = aggregate.state;

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "deadline_reached",
        deadline: "finalization_cutoff",
        at: 10_100,
      }),
    ).toEqual({
      aggregate: {
        ...aggregate,
        nextEffectSequence: 6,
        finalInput: {
          ...aggregate.finalInput,
          obligation: "settled",
          quietDeadline: 9_100,
          warning: "final_input_may_be_incomplete",
        },
        state: {
          ...endingFacts,
          stage: "finalizing",
          // The frozen result contains media commands that never started.
          effects: [
            ...aggregate.state.effects.map((effect) =>
              effect.status === "pending" ? { ...effect, status: "failed" } : effect,
            ),
            ...effects,
          ],
          warnings: ["final_input_may_be_incomplete", "drain_timed_out"],
        },
      },
      effects,
      events: [],
    });
  });

  it.each([
    { kind: "interrupted_effects_recovered" },
    {
      kind: "effect_outcome",
      effectId: "unknown_effect",
      outcome: { status: "dispatched" },
      at: 100,
    },
    {
      kind: "transcript_digest_computed",
      revision: 99,
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      at: 100,
    },
    { kind: "deadline_reached", deadline: "drain", at: 100 },
    { kind: "deadline_reached", deadline: "provider_close", at: 100 },
  ] as const)(
    "keeps common non-applicable live observation $kind structurally inert",
    (observation) => {
      const aggregate = liveAggregate();

      expect(advanceInterviewFinalization(aggregate, observation)).toEqual({
        aggregate,
        effects: [],
        events: [],
      });
    },
  );

  it("dispatches one persisted final commit and admits only the first item beyond its fence", () => {
    const ending = advanceInterviewFinalization(
      advanceInterviewFinalization(liveAggregate(), {
        kind: "reply_started",
        responseId: "response_before_finish",
        generation: 1,
        sequence: 4,
      }).aggregate,
      {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      },
    );
    const commit = ending.aggregate.state.effects.find((effect) => effect.kind === "close_input");
    if (commit === undefined) throw new Error("Expected final input commit effect.");
    const dispatched = advanceInterviewFinalization(ending.aggregate, {
      kind: "effect_outcome",
      effectId: commit.id,
      outcome: { status: "dispatched" },
      at: 101,
    });
    const admitted = advanceInterviewFinalization(dispatched.aggregate, {
      kind: "participant_answer_created",
      itemId: "final_item",
      generation: 1,
      sequence: 5,
    });
    const duplicate = advanceInterviewFinalization(admitted.aggregate, {
      kind: "participant_answer_created",
      itemId: "final_item",
      generation: 1,
      sequence: 6,
    });
    const late = advanceInterviewFinalization(duplicate.aggregate, {
      kind: "participant_answer_created",
      itemId: "late_item",
      generation: 1,
      sequence: 7,
    });

    expect(ending.aggregate.finalInput).toMatchObject({
      fence: { generation: 1, sequence: 4 },
      effectId: commit.id,
    });
    expect(admitted.aggregate.finalInput).toMatchObject({
      obligation: "awaiting_transcription",
      admittedItemId: "final_item",
    });
    expect(duplicate.aggregate.finalInput?.duplicateCount).toBe(1);
    expect(late.aggregate.state).toMatchObject({ warnings: ["post_end_input_leaked"] });
  });

  it("settles clean empty input after the final commit and one second of quiet", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const commit = ending.aggregate.state.effects.find((effect) => effect.kind === "close_input");
    if (commit === undefined) throw new Error("Expected final input commit effect.");
    const dispatched = advanceInterviewFinalization(ending.aggregate, {
      kind: "effect_outcome",
      effectId: commit.id,
      outcome: { status: "dispatched" },
      at: 101,
    });
    const quiet = advanceInterviewFinalization(dispatched.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 1_100,
    });

    expect(quiet.aggregate.finalInput).toMatchObject({
      obligation: "settled",
      warning: null,
    });
    expect(quiet.aggregate.state).toMatchObject({ stage: "finalizing", warnings: [] });
  });

  it("does not require speech_stopped after terminal final transcription", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const speechStarted = advanceInterviewFinalization(liveAggregate(), {
        kind: "session_activity_observed",
        at: 90,
        generation: 1,
        sequence: 1,
      });
      const ending = advanceInterviewFinalization(speechStarted.aggregate, {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      });
      const commit = ending.aggregate.state.effects.find((effect) => effect.kind === "close_input");
      if (commit === undefined) throw new Error("Expected final input commit effect.");
      const dispatched = advanceInterviewFinalization(ending.aggregate, {
        kind: "effect_outcome",
        effectId: commit.id,
        outcome: { status: "dispatched" },
        at: 101,
      });
      const admitted = advanceInterviewFinalization(dispatched.aggregate, {
        kind: "participant_answer_created",
        itemId: "final_speech",
        generation: 1,
        sequence: 2,
      });
      const transcribed = advanceInterviewFinalization(admitted.aggregate, {
        kind: "participant_answer_transcribed",
        itemId: "final_speech",
        text: "final answer",
        generation: 1,
        sequence: 3,
      });
      const quietDeadline = transcribed.aggregate.finalInput?.quietDeadline;
      if (quietDeadline === undefined) throw new Error("Expected a final input quiet deadline.");
      const closed = advanceInterviewFinalization(transcribed.aggregate, {
        kind: "deadline_reached",
        deadline: "drain",
        at: quietDeadline,
      });

      if (closed.aggregate.state.stage === "live") throw new Error("Expected an ending state.");
      expect(closed.aggregate.state.stage).toBe("finalizing");
      expect(stateWarnings(closed.aggregate.state)).not.toContain("drain_timed_out");
      expect(stateWarnings(closed.aggregate.state)).not.toContain("final_input_may_be_incomplete");
      expect(closed.aggregate.finalInput).toMatchObject({
        obligation: "settled",
        admittedItemId: "final_speech",
        warning: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns when input the closure was to settle produced no item by its quiet second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const ending = advanceInterviewFinalization(liveAggregate(), {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      });
      const commit = ending.aggregate.state.effects.find((effect) => effect.kind === "close_input");
      if (commit === undefined) throw new Error("Expected final input commit effect.");
      // The execution reports input to settle, and leaves the answer to Runtime's quiet second.
      const dispatched = advanceInterviewFinalization(ending.aggregate, {
        kind: "effect_outcome",
        effectId: commit.id,
        outcome: {
          status: "dispatched",
          settlement: { supersedesHeld: false, answerFollows: false, inputToSettle: true },
        },
        at: 101,
      });
      const quietDeadline = dispatched.aggregate.finalInput?.quietDeadline;
      if (quietDeadline === undefined) throw new Error("Expected a final input quiet deadline.");
      const quiet = advanceInterviewFinalization(dispatched.aggregate, {
        kind: "deadline_reached",
        deadline: "drain",
        at: quietDeadline,
      });

      if (quiet.aggregate.state.stage !== "finalizing") {
        throw new Error("Expected the warned final input to let the result freeze.");
      }
      expect(quiet.aggregate.state.warnings).toEqual(["final_input_may_be_incomplete"]);
      expect(quiet.aggregate.finalInput).toMatchObject({
        obligation: "settled",
        inputToSettle: true,
        answerFollows: false,
        warning: "final_input_may_be_incomplete",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat a rejected final commit as clean empty input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const ending = advanceInterviewFinalization(liveAggregate(), {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      });
      const commit = ending.aggregate.state.effects.find((effect) => effect.kind === "close_input");
      if (commit === undefined) throw new Error("Expected final input commit effect.");
      const dispatched = advanceInterviewFinalization(ending.aggregate, {
        kind: "effect_outcome",
        effectId: commit.id,
        outcome: { status: "dispatched" },
        at: 101,
      });
      const rejected = advanceInterviewFinalization(dispatched.aggregate, {
        kind: "session_error_observed",
        eventId: commit.id,
        code: "invalid_request_error",
        generation: 1,
        sequence: 1,
      });
      const quietDeadline = rejected.aggregate.finalInput?.quietDeadline;
      if (quietDeadline === undefined) throw new Error("Expected a final input quiet deadline.");
      const quiet = advanceInterviewFinalization(rejected.aggregate, {
        kind: "deadline_reached",
        deadline: "drain",
        at: quietDeadline,
      });

      expect(quiet.aggregate.state.stage).toBe("draining");
      expect(quiet.aggregate.finalInput).toMatchObject({
        obligation: "awaiting_item",
        warning: null,
      });
      const bounded = advanceInterviewFinalization(quiet.aggregate, {
        kind: "deadline_reached",
        deadline: "finalization_cutoff",
        at: 10_100,
      });
      if (bounded.aggregate.state.stage !== "finalizing") {
        throw new Error("Expected the result to freeze at the finalization cutoff.");
      }
      expect(bounded.aggregate.state.warnings).toContain("final_input_may_be_incomplete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a terminal transcription failure of the final item with its warning", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const item = advanceInterviewFinalization(ending.aggregate, {
      kind: "participant_answer_created",
      itemId: "failed_final_item",
      generation: 1,
      sequence: 2,
    });
    const failed = advanceInterviewFinalization(item.aggregate, {
      kind: "participant_answer_transcription_failed",
      itemId: "failed_final_item",
      code: "transcription_failed",
      generation: 1,
      sequence: 3,
    });
    expect(failed.aggregate.finalInput).toMatchObject({
      obligation: "settled",
      warning: "participant_transcription_failed",
    });
    if (failed.aggregate.state.stage === "live") throw new Error("Expected an ending state.");
    expect(stateWarnings(failed.aggregate.state)).toContain("participant_transcription_failed");
  });

  it("keeps the first trigger authoritative across later requests", () => {
    const first = receiveConversationReceipt(liveAggregate(), {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      responseStatus: "completed",
      generation: 1,
      sequence: 1,
      at: 100,
    });
    const repeat = advanceInterviewFinalization(first.aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 200,
    });

    expect(repeat.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "agent_requested_end",
      strategy: "hard_stop",
      endingStartedAt: 100,
    });
    expect(repeat.aggregate.gracefulCompletion).toMatchObject({
      participantMediaSafetyOverride: false,
      outputAudioSettlement: "pending",
    });
    expect(repeat.effects).toEqual([]);
    expect(first.effects.map((effect) => effect.kind)).toContain("stop_output");
  });

  it("does not admit graceful completion from an uncorrelated end request", () => {
    const decision = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "agent_requested_end",
      source: "browser_request",
      at: 100,
    });

    expect(decision.aggregate.state.stage).toBe("live");
    expect(decision.aggregate.gracefulCompletion).toBeNull();
    expect(decision.effects).toEqual([]);
    expect(decision.events).toEqual([]);
  });

  it("treats a finish signal carried by response.done as terminal response evidence", () => {
    const activeResponse = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_finished",
      generation: 1,
      sequence: 1,
    });
    const ending = receiveConversationReceipt(activeResponse.aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_finished",
      callId: "call_finished",
      responseStatus: "completed",
      at: 100,
      generation: 1,
      sequence: 2,
    });
    const commit = ending.aggregate.state.effects.find((effect) => effect.kind === "close_input");
    if (commit === undefined) throw new Error("Expected final input commit effect.");
    const commitSettled = advanceInterviewFinalization(ending.aggregate, {
      kind: "effect_outcome",
      effectId: commit.id,
      outcome: { status: "dispatched" },
      at: 100,
    });
    const audioSettled = advanceInterviewFinalization(commitSettled.aggregate, {
      kind: "reply_delivery_stopped",
      responseId: "response_finished",
      generation: 1,
      sequence: 3,
    });
    const closing = advanceInterviewFinalization(audioSettled.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    expect(ending.aggregate.state).toMatchObject({
      stage: "draining",
      admittedResponseId: "response_finished",
      activeResponseId: null,
    });
    expect(ending.aggregate.gracefulCompletion).toMatchObject({
      callId: "call_finished",
      responseId: "response_finished",
      responseSettlement: "completed",
      outputAudioSettlement: "pending",
    });
    expect(closing.aggregate.state).toMatchObject({
      stage: "closing_provider",
      warnings: [],
    });
  });

  it("keeps identity-free audio settlement ambiguous while responses overlap", () => {
    const first = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_closing",
      generation: 1,
      sequence: 1,
    });
    const overlap = advanceInterviewFinalization(first.aggregate, {
      kind: "reply_started",
      responseId: "response_later",
      generation: 1,
      sequence: 2,
    });
    const overlapAudio = advanceInterviewFinalization(overlap.aggregate, {
      kind: "reply_delivery_started",
      responseId: "response_later",
      generation: 1,
      sequence: 3,
    });
    const ending = receiveConversationReceipt(overlapAudio.aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      responseStatus: "completed",
      generation: 1,
      sequence: 4,
      at: 100,
    });
    const stopped = advanceInterviewFinalization(ending.aggregate, {
      kind: "reply_delivery_stopped",
      generation: 1,
      sequence: 5,
    });

    expect(stopped.aggregate.gracefulCompletion).toMatchObject({
      responseId: "response_closing",
      outputAudioSettlement: "pending",
    });
    expect(ending.effects).toContainEqual(
      expect.objectContaining({ kind: "cancel_reply", responseId: "response_later" }),
    );
    expect(ending.aggregate.state).toMatchObject({ warnings: [] });
  });

  it("settles identity-free output stop when the admitted response is the only candidate", () => {
    const ending = receiveConversationReceipt(liveAggregate(), {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      responseStatus: "completed",
      generation: 1,
      sequence: 1,
      at: 100,
    });
    const stopped = advanceInterviewFinalization(ending.aggregate, {
      kind: "reply_delivery_stopped",
      generation: 1,
      sequence: 2,
    });

    expect(stopped.aggregate.gracefulCompletion).toMatchObject({
      responseSettlement: "completed",
      outputAudioSettlement: "stopped",
    });
  });

  it("excludes a contained response with no audio from identity-free stop correlation", () => {
    const overlapping = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_later",
      generation: 1,
      sequence: 1,
    });
    const ending = receiveConversationReceipt(overlapping.aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      responseStatus: "completed",
      generation: 1,
      sequence: 2,
      at: 100,
    });
    const contained = advanceInterviewFinalization(ending.aggregate, {
      kind: "reply_cancelled",
      responseId: "response_later",
      generation: 1,
      sequence: 3,
    });
    const stopped = advanceInterviewFinalization(contained.aggregate, {
      kind: "reply_delivery_stopped",
      generation: 1,
      sequence: 4,
    });

    expect(stopped.aggregate.gracefulCompletion).toMatchObject({
      responseId: "response_closing",
      outputAudioSettlement: "stopped",
    });
  });

  it("keeps a hard-stop trigger when a valid finish signal arrives later", () => {
    const hardStop = advanceInterviewFinalization(liveAggregate(), {
      kind: "deadline_reached",
      deadline: "timebox",
      at: 100,
    });
    const finish = receiveConversationReceipt(hardStop.aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_too_late",
      callId: "call_too_late",
      responseStatus: "completed",
      generation: 1,
      sequence: 1,
      at: 101,
    });

    expect(finish.aggregate.state).toMatchObject({
      endReason: "timebox_reached",
      strategy: "hard_stop",
    });
    expect(finish.aggregate.gracefulCompletion).toBeNull();
    expect(finish.effects).toContainEqual(
      expect.objectContaining({ kind: "cancel_reply", responseId: "response_too_late" }),
    );
  });

  it("deduplicates the winning finish call without replacing its response", () => {
    const ending = receiveConversationReceipt(liveAggregate(), {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      generation: 1,
      sequence: 1,
      at: 100,
    });
    const replay = receiveConversationReceipt(ending.aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_conflict",
      callId: "call_finish",
      responseStatus: "completed",
      generation: 1,
      sequence: 2,
      at: 101,
    });

    expect(replay.aggregate.gracefulCompletion).toMatchObject({
      callId: "call_finish",
      responseId: "response_closing",
      responseSettlement: "pending",
    });
    expect(replay.effects).toContainEqual(
      expect.objectContaining({ kind: "cancel_reply", responseId: "response_conflict" }),
    );
    expect(replay.events).toEqual([]);
  });

  it("does not cancel the admitted response for a conflicting call on that response", () => {
    const ending = receiveConversationReceipt(liveAggregate(), {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      generation: 1,
      sequence: 1,
      at: 100,
    });
    const conflict = receiveConversationReceipt(ending.aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_other",
      responseStatus: "completed",
      generation: 1,
      sequence: 2,
      at: 101,
    });

    expect(conflict.aggregate.gracefulCompletion).toMatchObject({
      callId: "call_finish",
      responseId: "response_closing",
      responseSettlement: "completed",
    });
    expect(conflict.effects).not.toContainEqual(
      expect.objectContaining({ kind: "cancel_reply", responseId: "response_closing" }),
    );
  });

  it("freezes named closing text and rejects uncorrelated identity-free text", () => {
    const ending = receiveConversationReceipt(liveAggregate(), {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      generation: 1,
      sequence: 1,
      at: 100,
    });
    const uncorrelated = advanceInterviewFinalization(ending.aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "item_closing",
      text: "must not be inferred",
      generation: 1,
      sequence: 2,
    });
    const named = advanceInterviewFinalization(uncorrelated.aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "item_closing",
      responseId: "response_closing",
      text: "Thanks for your time.",
      generation: 1,
      sequence: 3,
    });
    const duplicate = advanceInterviewFinalization(named.aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "item_closing",
      responseId: "response_closing",
      text: "replacement text",
      generation: 1,
      sequence: 4,
    });

    expect(uncorrelated.aggregate.transcriptCapture.items).toEqual([]);
    expect(duplicate.aggregate.transcriptCapture.items).toContainEqual(
      expect.objectContaining({
        itemId: "item_closing",
        responseId: "response_closing",
        text: "Thanks for your time.",
      }),
    );
  });

  it("admits identity-free closing text only after the provider associated its item", () => {
    const ending = receiveConversationReceipt(liveAggregate(), {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      transcriptItems: [
        {
          itemId: "item_closing",
          responseId: "response_closing",
          role: "conversationAgent",
        },
      ],
      generation: 1,
      sequence: 1,
      at: 100,
    });
    const transcript = advanceInterviewFinalization(ending.aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "item_closing",
      text: "Thanks for your time.",
      generation: 1,
      sequence: 2,
    });

    expect(transcript.aggregate.transcriptCapture.items).toContainEqual(
      expect.objectContaining({
        itemId: "item_closing",
        responseId: "response_closing",
        text: "Thanks for your time.",
      }),
    );
  });

  it("admits closing item association from a response.done replay of the winning call", () => {
    const ending = receiveConversationReceipt(liveAggregate(), {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      generation: 1,
      sequence: 1,
      at: 100,
    });
    const replay = receiveConversationReceipt(ending.aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      responseStatus: "completed",
      transcriptItems: [
        {
          itemId: "item_closing",
          responseId: "response_closing",
          role: "conversationAgent",
        },
      ],
      generation: 1,
      sequence: 2,
      at: 101,
    });
    const transcript = advanceInterviewFinalization(replay.aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "item_closing",
      text: "Thanks for your time.",
      generation: 1,
      sequence: 3,
    });

    expect(transcript.aggregate.transcriptCapture.items).toContainEqual(
      expect.objectContaining({
        itemId: "item_closing",
        responseId: "response_closing",
        text: "Thanks for your time.",
      }),
    );
  });

  it("does not classify a repeated runtime failure trigger as a later failure", () => {
    const first = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "runtime_failed",
      source: "session_failure",
      at: 100,
    });
    const repeat = advanceInterviewFinalization(first.aggregate, {
      kind: "end_requested",
      reason: "runtime_failed",
      source: "session_failure",
      at: 200,
    });

    expect(repeat.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "runtime_failed",
      warnings: [],
    });
  });

  it("does not treat a sideband close as provider session closure", () => {
    const decision = advanceInterviewFinalization(liveAggregate(), {
      kind: "runtime_failure_observed",
      source: "session_disconnected",
      at: 100,
    });

    // Losing the live sideband ends the Run as a Runtime failure; the session is not closed.

    expect(decision.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "runtime_failed",
      sessionClosed: false,
    });
  });

  it("fails a live run when evidence proves the provider session already closed", () => {
    const decision = advanceInterviewFinalization(liveAggregate(), {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 1,
      at: 100,
    });

    expect(decision.aggregate.state).toMatchObject({
      stage: "draining",
      endReason: "runtime_failed",
      source: "session_closed_observed",
      sessionClosed: true,
    });
    expect(decision.events).toHaveLength(1);
    expect(decision.events[0]).toMatchObject({ type: "runtime.ending" });
    expect(decision.events[0]?.payload).toMatchObject({ endReason: "runtime_failed" });
  });

  it("freezes a digest-backed transcript only after the close bound", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const commit = ending.aggregate.state.effects.find((effect) => effect.kind === "close_input");
    if (commit === undefined) throw new Error("Expected final input commit effect.");
    const commitSettled = advanceInterviewFinalization(ending.aggregate, {
      kind: "effect_outcome",
      effectId: commit.id,
      outcome: { status: "dispatched" },
      at: 100,
    });
    const closing = advanceInterviewFinalization(commitSettled.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const hangupEffect = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangupEffect === undefined) throw new Error("Expected provider hangup effect.");
    const hangupSettled = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: hangupEffect.id,
      outcome: { status: "dispatched" },
      at: 9_100,
    });
    const finalizing = advanceInterviewFinalization(hangupSettled.aggregate, {
      kind: "deadline_reached",
      deadline: "finalization_cutoff",
      at: 10_100,
    });
    const digested = advanceInterviewFinalization(finalizing.aggregate, {
      kind: "transcript_digest_computed",
      revision: finalizing.aggregate.transcriptRevision,
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      at: 10_100,
    });

    expect(digested.aggregate.state.stage).toBe("ended");
    if (digested.aggregate.state.stage !== "ended") throw new Error("Expected ended state.");
    expect(digested.aggregate.state.completion).toMatchObject({
      endingStartedAt: 100,
      endedAt: 100,
      finalizedAt: 10_100,
    });
    expect(digested.events).toEqual([
      expect.objectContaining({ type: "runtime.controller_completed" }),
    ]);
    expect(digested.aggregate.state.publication.status).toBe("pending");
  });

  it("deduplicates provider observations by the persisted sequence", () => {
    const first = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "resp_1",
      generation: 1,
      sequence: 4,
    });
    const duplicate = advanceInterviewFinalization(first.aggregate, {
      kind: "reply_started",
      responseId: "resp_2",
      generation: 1,
      sequence: 4,
    });

    expect(duplicate.aggregate).toEqual(first.aggregate);
    expect(duplicate.events).toEqual([]);
  });

  it.each(["live", "draining", "closing_provider"] as const)(
    "keeps a duplicate provider decision idempotent while %s",
    (stage) => {
      const started = advanceInterviewFinalization(liveAggregate(), {
        kind: "reply_started",
        responseId: "duplicate-response",
        generation: 1,
        sequence: 1,
      });
      let aggregate = started.aggregate;
      if (stage !== "live") {
        aggregate = advanceInterviewFinalization(aggregate, {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 100,
        }).aggregate;
      }
      if (stage === "closing_provider") {
        aggregate = advanceInterviewFinalization(aggregate, {
          kind: "deadline_reached",
          deadline: "drain",
          at: 9_100,
        }).aggregate;
      }
      expect(aggregate.state.stage).toBe(stage);

      const decision = advanceInterviewFinalization(aggregate, {
        kind: "reply_generated",
        responseId: "duplicate-response",
        generation: 1,
        sequence: 1,
      });

      expect(decision).toEqual({ aggregate, effects: [], events: [] });
      expect(decision.aggregate).toBe(aggregate);
    },
  );

  it("waits for an accepted provider prefix and keeps its terminal retranscription idempotent", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const committed = settleFinalInputCommit(ending.aggregate);
    const admitted = advanceInterviewFinalization(committed, {
      kind: "participant_answer_created",
      itemId: "accepted-prefix-item",
      generation: 1,
      sequence: 1,
    });
    const closing = advanceInterviewFinalization(admitted.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    if (closing.aggregate.state.stage !== "closing_provider") {
      throw new Error("Expected provider-closing state.");
    }
    const hangup = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");

    const alreadyClosed = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "dispatched", code: "session_closed" },
      providerCloseBarrier: { generation: 1, sequence: 4 },
      at: 9_200,
    });
    expect(alreadyClosed.aggregate.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: true,
      providerCloseBarrier: { generation: 1, sequence: 4 },
    });
    expect(alreadyClosed.effects).toEqual([]);
    expect(alreadyClosed.events).toEqual([]);

    const terminal = advanceInterviewFinalization(alreadyClosed.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "accepted-prefix-item",
      text: "accepted prefix text",
      generation: 1,
      sequence: 2,
    });
    expect(terminal.aggregate.state.stage).toBe("closing_provider");
    expect(terminal.aggregate.transcriptRevision).toBe(1);
    expect(terminal.aggregate.transcriptCapture.items).toContainEqual(
      expect.objectContaining({
        itemId: "accepted-prefix-item",
        text: "accepted prefix text",
      }),
    );

    const repeated = advanceInterviewFinalization(terminal.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "accepted-prefix-item",
      text: "repeated terminal prefix",
      generation: 1,
      sequence: 3,
    });
    expect(repeated.aggregate.state.stage).toBe("closing_provider");
    expect(repeated.aggregate.transcriptRevision).toBe(terminal.aggregate.transcriptRevision);
    expect(repeated.aggregate.transcriptCapture).toBe(terminal.aggregate.transcriptCapture);
    expect(repeated.aggregate.finalInput).toBe(terminal.aggregate.finalInput);
    expect(repeated.effects).toEqual([]);
    expect(repeated.events).toEqual([]);
  });

  it("distinguishes clean provider closure from closure with admitted input pending", () => {
    const cleanEnding = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const cleanClosed = advanceInterviewFinalization(cleanEnding.aggregate, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 1,
      at: 200,
    });
    expect(cleanClosed.aggregate.state).toMatchObject({
      stage: "draining",
      sessionClosed: true,
      warnings: [],
    });

    const pendingEnding = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const pendingCommitted = settleFinalInputCommit(pendingEnding.aggregate);
    const pendingAdmitted = advanceInterviewFinalization(pendingCommitted, {
      kind: "participant_answer_created",
      itemId: "pending-close-item",
      generation: 1,
      sequence: 1,
    });
    const pendingClosed = advanceInterviewFinalization(pendingAdmitted.aggregate, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 2,
      at: 200,
    });
    expect(pendingClosed.aggregate.state).toMatchObject({
      stage: "draining",
      sessionClosed: true,
      warnings: ["session_closed_with_pending_input"],
    });
    expect(pendingClosed.effects).toEqual([]);
    expect(pendingClosed.events).toEqual([]);
  });

  it("increments the transcript revision when late provider ordering changes canonical turns", () => {
    const first = advanceInterviewFinalization(liveAggregate(), {
      kind: "participant_answer_transcribed",
      itemId: "item_a",
      text: "A",
      generation: 1,
      sequence: 1,
    });
    const second = advanceInterviewFinalization(first.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "item_b",
      text: "B",
      generation: 1,
      sequence: 2,
    });
    const reordered = advanceInterviewFinalization(second.aggregate, {
      kind: "transcript_item_observed",
      itemId: "item_a",
      previousItemId: "item_b",
      role: "participant",
      generation: 1,
      sequence: 3,
    });

    expect(second.aggregate.transcriptRevision).toBe(2);
    expect(reordered.aggregate.transcriptRevision).toBe(3);
  });

  it("does not create a transcript revision for empty final text", () => {
    const observed = advanceInterviewFinalization(liveAggregate(), {
      kind: "participant_answer_transcribed",
      itemId: "item_empty",
      text: "",
      generation: 1,
      sequence: 1,
    });

    expect(observed.aggregate.transcriptRevision).toBe(0);
    expect(observed.aggregate.transcriptCapture.items[0]?.text).toBeUndefined();
  });

  it("preserves nonblank final text without whitespace normalization", () => {
    const observed = advanceInterviewFinalization(liveAggregate(), {
      kind: "participant_answer_transcribed",
      itemId: "item_exact",
      text: "  exact final text\n",
      generation: 1,
      sequence: 1,
    });

    expect(observed.aggregate.transcriptCapture.items[0]?.text).toBe("  exact final text\n");
  });

  it("keeps a repeated provider hangup outcome structurally inert", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const hangup = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const settled = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "dispatched" },
      at: 9_200,
    });
    const repeated = advanceInterviewFinalization(settled.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "dispatched" },
      at: 9_900,
    });

    expect(repeated.aggregate).toBe(settled.aggregate);
    expect(repeated.effects).toEqual([]);
    expect(repeated.events).toEqual([]);
  });

  it("preserves the exact dispatched provider-hangup decision while close evidence is pending", () => {
    const aggregate = closingProviderAggregate();
    const hangup = aggregate.state.effects.find((effect) => effect.kind === "release_session");
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const effects = aggregate.state.effects.map((effect) =>
      effect.id === hangup.id
        ? { ...effect, status: "dispatched" as const, attemptCount: 1 }
        : effect,
    );

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "effect_outcome",
        effectId: hangup.id,
        outcome: { status: "dispatched" },
        at: 9_200,
      }),
    ).toEqual({
      aggregate: {
        ...aggregate,
        state: {
          ...aggregate.state,
          effects,
        },
      },
      effects: [],
      events: [],
    });
  });

  it("preserves the exact uncertain provider-hangup warning and bounded close decision", () => {
    const aggregate = closingProviderAggregate();
    const hangup = aggregate.state.effects.find((effect) => effect.kind === "release_session");
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const effects = aggregate.state.effects.map((effect) =>
      effect.id === hangup.id
        ? { ...effect, status: "uncertain" as const, attemptCount: 1 }
        : effect,
    );

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "effect_outcome",
        effectId: hangup.id,
        outcome: { status: "uncertain", code: "session_release_uncertain" },
        at: 9_200,
      }),
    ).toEqual({
      aggregate: {
        ...aggregate,
        state: {
          ...aggregate.state,
          effects,
          warnings: ["session_release_uncertain"],
        },
      },
      effects: [],
      events: [],
    });
  });

  it("treats already-closed hangup dispatch as the exact benign terminal decision", () => {
    const aggregate = closingProviderAggregate();
    const hangup = aggregate.state.effects.find((effect) => effect.kind === "release_session");
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const settledEffects = aggregate.state.effects.map((effect) => {
      if (effect.id === hangup.id) {
        return { ...effect, status: "dispatched" as const, attemptCount: 1 };
      }
      if (
        (effect.kind === "close_input" && effect.heldItemId !== null) ||
        effect.kind === "discard_later_input" ||
        effect.kind === "stop_output"
      ) {
        return {
          ...effect,
          status: "dispatched" as const,
          acceptance: "benign_rejection" as const,
        };
      }
      return effect;
    });

    // Closure is recorded and socket commands are contained; the owed transcription keeps
    // the result open.

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "effect_outcome",
        effectId: hangup.id,
        outcome: { status: "dispatched", code: "session_closed" },
        at: 9_200,
      }),
    ).toEqual({
      aggregate: {
        ...aggregate,
        state: {
          ...aggregate.state,
          sessionClosed: true,
          effects: settledEffects,
        },
      },
      effects: [],
      events: [],
    });
  });

  it("preserves ordered close evidence and contains the post-barrier observation exactly", () => {
    const aggregate = closingProviderAggregate();
    const containmentEffects = aggregate.state.effects.map((effect) =>
      (effect.kind === "close_input" && effect.heldItemId !== null) ||
      effect.kind === "discard_later_input" ||
      effect.kind === "stop_output"
        ? {
            ...effect,
            status: "dispatched" as const,
            acceptance: "benign_rejection" as const,
          }
        : effect,
    );
    const closedAggregate = {
      ...aggregate,
      nextProviderSequence: 4,
      acceptedProviderOrder: { generation: 1, sequence: 3 },
      runtimeUsage: { ...aggregate.runtimeUsage, incomplete: true },
      state: {
        ...aggregate.state,
        sessionClosed: true,
        providerCloseBarrier: { generation: 1, sequence: 3 },
        effects: containmentEffects,
        warnings: ["session_closed_with_pending_input"],
      },
    };

    const closed = advanceInterviewFinalization(aggregate, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 3,
      at: 9_200,
    });
    expect(closed).toEqual({ aggregate: closedAggregate, effects: [], events: [] });

    expect(
      advanceInterviewFinalization(closed.aggregate, {
        kind: "participant_answer_transcribed",
        itemId: "post_barrier_item",
        text: "must remain contained",
        generation: 1,
        sequence: 4,
        usage: unknownTranscription("post_barrier_item"),
      }),
    ).toEqual({
      aggregate: {
        ...closedAggregate,
        nextProviderSequence: 5,
        acceptedProviderOrder: { generation: 1, sequence: 4 },
        // Usage stays accountable even when the Transcript is sealed.
        runtimeUsage: {
          ...closedAggregate.runtimeUsage,
          processedKeys: [
            "speech_to_text:post_barrier_item",
            "speech_to_text:post_barrier_item:unknown",
          ],
        },
      },
      effects: [],
      events: [],
    });
  });

  it("persists a matching Transcript digest while provider closure remains pending", () => {
    const aggregate = closingProviderAggregate();
    const digest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "transcript_digest_computed",
        revision: aggregate.transcriptRevision,
        digest,
        at: 9_200,
      }),
    ).toEqual({
      aggregate: {
        ...aggregate,
        transcriptDigest: digest,
      },
      effects: [],
      events: [],
    });
  });

  it("persists only the serializable provider close barrier order", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const hangup = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const alreadyClosed = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "dispatched", code: "session_closed" },
      providerCloseBarrier: {
        providerEventId: "event_not_part_of_the_persisted_barrier",
        generation: 1,
        sequence: 2,
      },
      at: 9_200,
    });

    expect(alreadyClosed.aggregate.state).toMatchObject({
      stage: "closing_provider",
      providerCloseBarrier: { generation: 1, sequence: 2 },
    });
    if (alreadyClosed.aggregate.state.stage !== "closing_provider") {
      throw new Error("Expected the accepted provider prefix to remain pending.");
    }
    expect(alreadyClosed.aggregate.state.providerCloseBarrier).not.toHaveProperty(
      "providerEventId",
    );
    expect(isInterviewFinalizationAggregate(alreadyClosed.aggregate)).toBe(true);
  });

  it("defers unsettled final input without closing before the drain deadline", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const premature = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_099,
    });

    expect(premature.aggregate.state.stage).toBe("draining");
    expect(premature.aggregate.finalInput).toMatchObject({
      obligation: "awaiting_item",
      quietDeadline: 9_100,
    });
    expect(premature.effects).toEqual([]);
  });

  it("reconciles a failed hangup command when provider closure is later observed", () => {
    const closing = closingProviderAggregate();
    const hangup = closing.state.effects.find((effect) => effect.kind === "release_session");
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const failed = advanceInterviewFinalization(closing, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "failed", code: "session_release_failed" },
      at: 9_200,
    });
    const closed = advanceInterviewFinalization(failed.aggregate, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 2,
      at: 9_300,
    });

    expect(failed.aggregate.state).toMatchObject({
      warnings: ["session_release_failed"],
    });

    expect(closed.aggregate.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: true,
      warnings: ["session_closed_with_pending_input"],
    });
  });

  it("reconciles a failed hangup when provider closure was observed first", () => {
    const closed = advanceInterviewFinalization(closingProviderAggregate(), {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 2,
      at: 9_150,
    });
    const hangup = closed.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const failed = advanceInterviewFinalization(closed.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "failed", code: "session_release_failed" },
      at: 9_200,
    });
    const frozen = advanceInterviewFinalization(failed.aggregate, {
      kind: "deadline_reached",
      deadline: "finalization_cutoff",
      at: 10_100,
    });

    expect(frozen.aggregate.state).toMatchObject({
      stage: "finalizing",
      sessionClosed: true,
    });
    if (frozen.aggregate.state.stage !== "finalizing") throw new Error("Expected finalizing.");
    expect(frozen.aggregate.state.warnings).not.toContain("session_release_failed");
  });

  it("seals Transcript admission when provider closure is accepted before hangup settles", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const commit = ending.aggregate.state.effects.find((effect) => effect.kind === "close_input");
    if (commit === undefined) throw new Error("Expected final input commit effect.");
    const committed = advanceInterviewFinalization(ending.aggregate, {
      kind: "effect_outcome",
      effectId: commit.id,
      outcome: { status: "dispatched" },
      at: 101,
    });
    const admitted = advanceInterviewFinalization(committed.aggregate, {
      kind: "participant_answer_created",
      itemId: "queued-before-close",
      generation: 1,
      sequence: 1,
    });
    const closing = advanceInterviewFinalization(admitted.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const providerClosed = advanceInterviewFinalization(closing.aggregate, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 2,
      at: 9_200,
    });
    const hangup = providerClosed.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const alreadyClosed = advanceInterviewFinalization(providerClosed.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "dispatched", code: "session_closed" },
      providerCloseBarrier: { generation: 1, sequence: 3 },
      at: 9_201,
    });
    const revisionAtBarrier = providerClosed.aggregate.transcriptRevision;
    const afterBarrier = advanceInterviewFinalization(alreadyClosed.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "queued-before-close",
      text: "must not cross the accepted close barrier",
      generation: 1,
      sequence: 3,
    });

    expect(providerClosed.aggregate.state.stage).toBe("closing_provider");
    expect(alreadyClosed.aggregate.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: true,
      providerCloseBarrier: { generation: 1, sequence: 2 },
    });
    expect(afterBarrier.aggregate.transcriptRevision).toBe(revisionAtBarrier);
    expect(afterBarrier.aggregate.transcriptCapture).toBe(
      providerClosed.aggregate.transcriptCapture,
    );
  });

  it("keeps a digest effect retryable until its matching digest is persisted", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const hangup = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const hangupSettled = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "dispatched" },
      at: 9_200,
    });
    const finalizing = advanceInterviewFinalization(hangupSettled.aggregate, {
      kind: "deadline_reached",
      deadline: "finalization_cutoff",
      at: 10_100,
    });
    const digest = finalizing.aggregate.state.effects.find(
      (effect) => effect.kind === "compute_transcript_digest",
    );
    if (digest === undefined) throw new Error("Expected Transcript digest effect.");
    const dispatched = advanceInterviewFinalization(finalizing.aggregate, {
      kind: "effect_outcome",
      effectId: digest.id,
      outcome: { status: "dispatched" },
      at: 10_101,
    });

    expect(
      dispatched.aggregate.state.effects.find((effect) => effect.id === digest.id)?.status,
    ).toBe("pending");
    expect(dispatched.aggregate.transcriptDigest).toBeNull();
  });

  it("does not recreate a failed provider command under a new effect identity", () => {
    const liveWithResponse = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_admitted",
      generation: 1,
      sequence: 1,
    }).aggregate;
    const ending = advanceInterviewFinalization(liveWithResponse, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    }).aggregate;
    const lateResponse = advanceInterviewFinalization(ending, {
      kind: "reply_started",
      responseId: "response_late",
      generation: 1,
      sequence: 2,
    }).aggregate;
    const cancellation = lateResponse.state.effects.find(
      (effect) => effect.kind === "cancel_reply" && effect.responseId === "response_late",
    );
    if (cancellation === undefined) throw new Error("Expected late response cancellation.");
    const failed = advanceInterviewFinalization(lateResponse, {
      kind: "effect_outcome",
      effectId: cancellation.id,
      outcome: { status: "failed", code: "session_unavailable_before_dispatch" },
      at: 101,
    }).aggregate;

    const duplicateObservation = advanceInterviewFinalization(failed, {
      kind: "reply_started",
      responseId: "response_late",
      generation: 1,
      sequence: 3,
    }).aggregate;

    expect(
      duplicateObservation.state.effects.filter(
        (effect) => effect.kind === "cancel_reply" && effect.responseId === "response_late",
      ),
    ).toEqual([expect.objectContaining({ id: cancellation.id, status: "failed" })]);
  });

  it("does not resend an uncertain cancellation after its response is already terminal", () => {
    const active = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_to_cancel",
      generation: 1,
      sequence: 1,
    });
    const ending = advanceInterviewFinalization(active.aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const cancellation = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "cancel_reply",
    );
    if (cancellation === undefined) throw new Error("Expected response cancellation.");
    const uncertain = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: cancellation.id,
      outcome: { status: "uncertain", code: "sideband_unavailable" },
      at: 9_101,
    });
    const responseDone = advanceInterviewFinalization(uncertain.aggregate, {
      kind: "reply_generated",
      responseId: "response_to_cancel",
      generation: 1,
      sequence: 2,
    });
    const reconnected = { aggregate: responseDone.aggregate, effects: [], events: [] };

    expect(
      reconnected.aggregate.state.effects.find((effect) => effect.id === cancellation.id),
    ).toMatchObject({
      status: "dispatched",
      acceptance: "benign_rejection",
      attemptCount: 1,
    });
  });

  it("does not retry a correlated rejected cancellation while its response remains active", () => {
    const active = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_rejected_cancel",
      generation: 1,
      sequence: 1,
    });
    const ending = advanceInterviewFinalization(active.aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const cancellation = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "cancel_reply",
    );
    if (cancellation === undefined) throw new Error("Expected response cancellation.");
    const dispatched = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: cancellation.id,
      outcome: { status: "dispatched" },
      at: 9_101,
    });
    const rejected = advanceInterviewFinalization(dispatched.aggregate, {
      kind: "session_error_observed",
      eventId: cancellation.id,
      code: "response_cancel_failed",
      generation: 1,
      sequence: 2,
    });
    expect(
      rejected.aggregate.state.effects.find((effect) => effect.id === cancellation.id),
    ).toMatchObject({ status: "failed", acceptance: "rejected" });

    const reconnected = { aggregate: rejected.aggregate, effects: [], events: [] };
    expect(
      reconnected.aggregate.state.effects.find((effect) => effect.id === cancellation.id),
    ).toMatchObject({ status: "failed", acceptance: "rejected" });
  });

  it("distinguishes a contained provider command failure from actual output leakage", () => {
    const active = advanceInterviewFinalization(liveAggregate(), {
      kind: "reply_started",
      responseId: "response_to_contain",
      generation: 1,
      sequence: 1,
    });
    const ending = advanceInterviewFinalization(active.aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const cancellation = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "cancel_reply",
    );
    if (cancellation === undefined) throw new Error("Expected response cancellation.");
    const failed = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: cancellation.id,
      outcome: { status: "failed", code: "provider_command_send_failed" },
      at: 9_101,
    });
    const contained = advanceInterviewFinalization(failed.aggregate, {
      kind: "reply_generated",
      responseId: "response_to_contain",
      generation: 1,
      sequence: 2,
    });
    const laterResponse = advanceInterviewFinalization(failed.aggregate, {
      kind: "reply_started",
      responseId: "response_after_end",
      generation: 1,
      sequence: 2,
    });
    const leaked = advanceInterviewFinalization(laterResponse.aggregate, {
      kind: "reply_delivery_started",
      responseId: "response_after_end",
      generation: 1,
      sequence: 3,
    });

    if (contained.aggregate.state.stage === "live" || contained.aggregate.state.stage === "ended") {
      throw new Error("Expected active finalization state.");
    }
    if (leaked.aggregate.state.stage === "live" || leaked.aggregate.state.stage === "ended") {
      throw new Error("Expected active finalization state.");
    }
    expect(contained.aggregate.state.warnings).not.toContain("post_end_output_leaked");
    expect(leaked.aggregate.state.warnings).toContain("post_end_output_leaked");
  });

  it("admits one final input item and rejects later transcript text", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const admitted = advanceInterviewFinalization(ending.aggregate, {
      kind: "participant_answer_created",
      itemId: "input_final",
      generation: 1,
      sequence: 1,
    });
    const captured = advanceInterviewFinalization(admitted.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "input_final",
      text: "final answer",
      generation: 1,
      sequence: 2,
    });
    const lateInput = advanceInterviewFinalization(captured.aggregate, {
      kind: "participant_answer_created",
      itemId: "input_late",
      generation: 1,
      sequence: 3,
    });
    const lateTranscript = advanceInterviewFinalization(lateInput.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "input_late",
      text: "late answer",
      generation: 1,
      sequence: 4,
    });

    expect(
      lateTranscript.aggregate.transcriptCapture.items.some(
        (item) => item.itemId === "input_late" && item.text === "late answer",
      ),
    ).toBe(false);
    expect(lateTranscript.aggregate.state).toMatchObject({
      stage: "draining",
      warnings: ["post_end_input_leaked"],
    });
  });

  it("does not mutate a frozen aggregate when late provider facts arrive", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const hangup = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const settled = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "dispatched" },
      at: 9_100,
    });
    const finalizing = advanceInterviewFinalization(settled.aggregate, {
      kind: "deadline_reached",
      deadline: "finalization_cutoff",
      at: 10_100,
    });
    const ended = advanceInterviewFinalization(finalizing.aggregate, {
      kind: "transcript_digest_computed",
      revision: finalizing.aggregate.transcriptRevision,
      digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const late = advanceInterviewFinalization(ended.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "late",
      text: "must not be captured",
      generation: 1,
      sequence: 1,
    });

    expect(late.aggregate).toBe(ended.aggregate);
    expect(late.effects).toEqual([]);
    expect(late.events).toEqual([]);
  });

  it("returns the original ended aggregate for every observation kind", () => {
    const aggregate = endedAggregate();

    for (const [kind, observation] of Object.entries(endedObservations)) {
      const decision = advanceInterviewFinalization(aggregate, observation);

      expect(decision.aggregate, kind).toBe(aggregate);
      expect(decision.effects, `${kind}: effects`).toEqual([]);
      expect(decision.events, `${kind}: events`).toEqual([]);
    }
  });

  it("keeps provider facts diagnostic-only after finalizing begins", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    });
    const closing = advanceInterviewFinalization(ending.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const hangup = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "release_session",
    );
    if (hangup === undefined) throw new Error("Expected provider hangup effect.");
    const settled = advanceInterviewFinalization(closing.aggregate, {
      kind: "effect_outcome",
      effectId: hangup.id,
      outcome: { status: "dispatched" },
      at: 9_200,
    });
    const finalizing = advanceInterviewFinalization(settled.aggregate, {
      kind: "deadline_reached",
      deadline: "finalization_cutoff",
      at: 10_100,
    });
    const lateOutput = advanceInterviewFinalization(finalizing.aggregate, {
      kind: "reply_delivery_started",
      responseId: "response_too_late",
      generation: 1,
      sequence: 1,
    });

    expect(lateOutput.aggregate.state).toEqual(finalizing.aggregate.state);
    expect(lateOutput.aggregate.transcriptCapture).toEqual(finalizing.aggregate.transcriptCapture);
  });

  it("settles a matching finalizing digest into the exact frozen completion decision", () => {
    const aggregate = endingAggregateAtStage(
      {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      },
      "finalizing",
    );
    if (aggregate.state.stage !== "finalizing") throw new Error("Expected finalizing state.");
    const digest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const effects = aggregate.state.effects.map((effect) =>
      effect.kind === "compute_transcript_digest" &&
      effect.revision === aggregate.transcriptRevision
        ? { ...effect, status: "dispatched" as const }
        : effect,
    );
    const completion = {
      runId: "run_250",
      outcome: "ended" as const,
      endReason: "participant_stopped" as const,
      source: "browser_request",
      endingStartedAt: 100,
      endedAt: 100,
      finalizationCutoffAt: 10_100,
      finalizedAt: 9_300,
      transcriptSnapshot: {
        revision: 1,
        digest,
        turnCount: 1,
      },
      warnings: [],
    };

    const decision = advanceInterviewFinalization(aggregate, {
      kind: "transcript_digest_computed",
      revision: aggregate.transcriptRevision,
      digest,
      at: 9_300,
    });

    expect(decision).toEqual({
      aggregate: {
        ...aggregate,
        transcriptDigest: digest,
        nextEventSequence: aggregate.nextEventSequence + 1,
        applicationTranscriptProof: {
          ...aggregate.applicationTranscriptProof,
          result: {
            runId: "run_250",
            outcome: "completed",
            reason: "participant_stopped",
            liveAt: 0,
            endedAt: 100,
            transcriptSnapshot: completion.transcriptSnapshot,
            transcriptCompleteness: "complete",
            transcriptIncompleteReasons: [],
            runtimeUsage: { completeness: "incomplete", observations: [] },
          },
        },
        state: {
          stage: "ended",
          completion,
          publication: {
            status: "pending",
            publicationCutoffAt: 39_300,
            transcriptDelivered: false,
            completionDelivered: false,
            retryAt: null,
            attemptCount: 0,
            deliveredAt: null,
            lastError: null,
          },
          effects,
        },
      },
      effects: [],
      events: [
        {
          id: `run_250:event:${aggregate.nextEventSequence}`,
          type: "runtime.controller_completed",
          payload: { completion },
        },
      ],
    });
  });

  it("keeps a stale finalizing digest structurally unchanged", () => {
    const aggregate = endingAggregateAtStage(
      {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      },
      "finalizing",
    );

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "transcript_digest_computed",
        revision: aggregate.transcriptRevision + 1,
        digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        at: 9_300,
      }),
    ).toEqual({ aggregate, effects: [], events: [] });
  });

  it("keeps a dispatched finalizing digest effect retryable until digest settlement", () => {
    const aggregate = endingAggregateAtStage(
      {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      },
      "finalizing",
    );
    if (aggregate.state.stage !== "finalizing") throw new Error("Expected finalizing state.");
    const digestEffect = aggregate.state.effects.find(
      (effect) => effect.kind === "compute_transcript_digest",
    );
    if (digestEffect === undefined) throw new Error("Expected Transcript digest effect.");
    const effects = aggregate.state.effects.map((effect) =>
      effect.id === digestEffect.id ? { ...effect, attemptCount: 1 } : effect,
    );

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "effect_outcome",
        effectId: digestEffect.id,
        outcome: { status: "dispatched" },
        at: 9_301,
      }),
    ).toEqual({
      aggregate: { ...aggregate, state: { ...aggregate.state, effects } },
      effects: [],
      events: [],
    });
  });

  it("preserves the established failed finalizing digest effect decision", () => {
    const aggregate = endingAggregateAtStage(
      {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      },
      "finalizing",
    );
    if (aggregate.state.stage !== "finalizing") throw new Error("Expected finalizing state.");
    const digestEffect = aggregate.state.effects.find(
      (effect) => effect.kind === "compute_transcript_digest",
    );
    if (digestEffect === undefined) throw new Error("Expected Transcript digest effect.");
    const effects = aggregate.state.effects.map((effect) =>
      effect.id === digestEffect.id
        ? { ...effect, status: "failed" as const, attemptCount: 1 }
        : effect,
    );

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "effect_outcome",
        effectId: digestEffect.id,
        outcome: { status: "failed", code: "digest_computation_failed" },
        at: 9_302,
      }),
    ).toEqual({
      aggregate: { ...aggregate, state: { ...aggregate.state, effects } },
      effects: [],
      events: [],
    });
  });

  it("updates finalizing provider evidence without changing frozen lifecycle or Transcript data", () => {
    const aggregate = endingAggregateAtStage(
      {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      },
      "finalizing",
    );
    const observation = {
      kind: "reply_started",
      responseId: "response_after_finalizing",
      generation: 2,
      sequence: 1,
      usage: [
        {
          status: "expected",
          componentRole: "speech_to_speech",
          key: "speech_to_speech:response_after_finalizing",
        },
      ],
    } as const;

    expect(advanceInterviewFinalization(aggregate, observation)).toEqual({
      aggregate: {
        ...aggregate,
        nextProviderSequence: 2,
        providerGeneration: 2,
        acceptedProviderOrder: { generation: 2, sequence: 1 },
        providerResponses: [
          ...aggregate.providerResponses,
          {
            responseId: "response_after_finalizing",
            status: "active",
            outputAudio: "pending",
          },
        ],
        runtimeUsage: {
          ...aggregate.runtimeUsage,
          pending: [
            ...aggregate.runtimeUsage.pending,
            {
              componentRole: "speech_to_speech",
              key: "speech_to_speech:response_after_finalizing",
            },
          ],
        },
      },
      effects: [],
      events: [],
    });
  });

  it("contains a post-trigger Runtime failure in finalizing with the exact warning decision", () => {
    const aggregate = endingAggregateAtStage(
      { kind: "deadline_reached", deadline: "presence_grace", at: 100 },
      "finalizing",
    );
    if (aggregate.state.stage !== "finalizing") throw new Error("Expected finalizing state.");

    expect(
      advanceInterviewFinalization(aggregate, {
        kind: "runtime_failure_observed",
        source: "session_failure",
        at: 9_302,
      }),
    ).toEqual({
      aggregate: {
        ...aggregate,
        state: {
          ...aggregate.state,
          warnings: [...aggregate.state.warnings, "runtime_failed_during_finalization"],
        },
      },
      effects: [],
      events: [],
    });
  });

  it("recovers an interrupted finalizing digest effect without settling completion", () => {
    const aggregate = endingAggregateAtStage(
      {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 100,
      },
      "finalizing",
    );
    if (aggregate.state.stage !== "finalizing") throw new Error("Expected finalizing state.");
    const digestEffect = aggregate.state.effects.find(
      (effect) => effect.kind === "compute_transcript_digest",
    );
    if (digestEffect === undefined) throw new Error("Expected Transcript digest effect.");
    const interruptedEffects = aggregate.state.effects.map((effect) =>
      effect.id === digestEffect.id ? { ...effect, status: "sending" as const } : effect,
    );
    const interrupted = {
      ...aggregate,
      state: { ...aggregate.state, effects: interruptedEffects },
    };
    const recoveredEffects = interruptedEffects.map((effect) =>
      effect.id === digestEffect.id
        ? { ...effect, status: "pending" as const, attemptCount: effect.attemptCount + 1 }
        : effect,
    );

    expect(
      advanceInterviewFinalization(interrupted, { kind: "interrupted_effects_recovered" }),
    ).toEqual({
      aggregate: {
        ...interrupted,
        state: { ...interrupted.state, effects: recoveredEffects },
      },
      effects: [],
      events: [],
    });
  });

  it.each([
    { kind: "interrupted_effects_recovered" },
    {
      kind: "effect_outcome",
      effectId: "unknown_finalizing_effect",
      outcome: { status: "dispatched" },
      at: 9_303,
    },
    { kind: "deadline_reached", deadline: "drain", at: 9_303 },
    { kind: "deadline_reached", deadline: "provider_close", at: 9_303 },
  ] as const)(
    "keeps common non-applicable finalizing observation $kind structurally inert",
    (observation) => {
      const aggregate = endingAggregateAtStage(
        {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 100,
        },
        "finalizing",
      );

      expect(advanceInterviewFinalization(aggregate, observation)).toEqual({
        aggregate,
        effects: [],
        events: [],
      });
    },
  );

  it("owns interrupted-effect recovery and its warning consequences", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    }).aggregate;
    const interrupted: InterviewFinalizationAggregate = {
      ...ending,
      nextEffectSequence: 4,
      state: {
        ...ending.state,
        effects: [
          {
            id: "run_250:3",
            kind: "release_session",
            status: "sending",
            acceptance: "unobserved",
            attemptCount: 0,
          },
        ],
      },
    };

    const recovered = advanceInterviewFinalization(interrupted, {
      kind: "interrupted_effects_recovered",
    });

    expect(recovered.aggregate.state).toMatchObject({
      effects: [expect.objectContaining({ status: "uncertain", attemptCount: 1 })],
      warnings: ["session_release_uncertain"],
    });
  });

  it.each([
    ["compute_transcript_digest", "pending"],
    ["close_input", "uncertain"],
    ["discard_later_input", "uncertain"],
    ["cancel_reply", "uncertain"],
    ["stop_output", "uncertain"],
    ["release_session", "uncertain"],
    ["arm_alarm", "pending"],
  ] as const)("recovers interrupted %s as %s without repeating its consequence", (kind, status) => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    }).aggregate;
    const effectFields = {
      id: `${ending.runId}:${ending.nextEffectSequence}`,
      status: "sending",
      acceptance: "unobserved",
      attemptCount: 0,
    } as const;
    const interruptedEffect: FinalizationEffectRecord =
      kind === "cancel_reply"
        ? { ...effectFields, kind, responseId: "response_recovery" }
        : kind === "compute_transcript_digest"
          ? { ...effectFields, kind, revision: ending.transcriptRevision }
          : kind === "close_input"
            ? { ...effectFields, kind, heldItemId: null }
            : { ...effectFields, kind };
    const interrupted: InterviewFinalizationAggregate = {
      ...ending,
      nextEffectSequence: ending.nextEffectSequence + 1,
      state: { ...ending.state, effects: [interruptedEffect] },
    };
    const recovered = advanceInterviewFinalization(interrupted, {
      kind: "interrupted_effects_recovered",
    });

    expect(recovered.aggregate.state.effects).toEqual([
      expect.objectContaining({ kind, status, attemptCount: 1 }),
    ]);
    expect(recovered.effects).toEqual([]);
    expect(recovered.events).toEqual([]);
    if (kind === "release_session") {
      const recoveredState = recovered.aggregate.state;
      if (recoveredState.stage === "live") throw new Error("Expected a draining state.");
      expect(stateWarnings(recoveredState)).toContain("session_release_uncertain");
    }
  });

  it("reads nothing to settle only as the input closure's answer, and no provider error code", () => {
    const ending = advanceInterviewFinalization(liveAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 100,
    }).aggregate;
    const closure = ending.state.effects.find((effect) => effect.kind === "close_input");
    const stop = ending.state.effects.find((effect) => effect.kind === "stop_output");
    if (closure === undefined || stop === undefined) throw new Error("Expected Ending's steps.");

    // Another step's answer is not the input closure's.
    const elsewhere = advanceInterviewFinalization(ending, {
      kind: "nothing_to_settle",
      commandId: stop.id,
      generation: 1,
      sequence: 1,
    }).aggregate;
    expect(elsewhere.state.effects).toEqual(ending.state.effects);
    expect(elsewhere.finalInput?.obligation).toBe("awaiting_item");

    // A provider's rejection of the step is a refusal, whatever its code says.
    const refused = advanceInterviewFinalization(ending, {
      kind: "session_error_observed",
      eventId: closure.id,
      code: "input_audio_buffer_commit_empty",
      generation: 1,
      sequence: 1,
    }).aggregate;
    expect(refused.state.effects.find((effect) => effect.id === closure.id)).toMatchObject({
      status: "failed",
      acceptance: "rejected",
    });
    expect(refused.finalInput?.obligation).toBe("awaiting_item");

    const settled = advanceInterviewFinalization(ending, {
      kind: "nothing_to_settle",
      commandId: closure.id,
      generation: 1,
      sequence: 1,
    }).aggregate;
    expect(settled.state.effects.find((effect) => effect.id === closure.id)).toMatchObject({
      status: "dispatched",
      acceptance: "benign_rejection",
    });
    expect(settled.finalInput?.obligation).toBe("settled");
  });
});
