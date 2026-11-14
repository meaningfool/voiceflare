import { describe, expect, it, vi } from "vitest";

import {
  liveFinalizationAggregate,
  receiveConversationReceipt,
} from "./testing/finalizationFixtures.ts";

import { advanceInterviewFinalization } from "./interviewFinalizationFSM.ts";
import { type InterviewFinalizationAggregate } from "./interviewFinalizationModel.ts";

describe("Interview finalization critical sequences", () => {
  it("preserves terminal transcription without speech_stopped in a bounded short sequence", () => {
    const active = advanceInterviewFinalization(liveAggregate("terminal-without-stop"), {
      kind: "session_activity_observed",
      generation: 1,
      sequence: 1,
      at: 90,
    });
    const ending = end(active.aggregate);
    const committed = settleEffect(ending.aggregate, "close_input", 101);
    const admitted = advanceInterviewFinalization(committed, {
      kind: "participant_answer_created",
      itemId: "delayed-final-item",
      generation: 1,
      sequence: 2,
    });
    const terminal = advanceInterviewFinalization(admitted.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "delayed-final-item",
      text: "the delayed final answer",
      generation: 1,
      sequence: 3,
    });

    expect(terminal.aggregate.finalInput).toMatchObject({
      obligation: "settled",
      admittedItemId: "delayed-final-item",
      inputToSettle: false,
      answerFollows: false,
      warning: null,
    });
    expect(terminal.aggregate.transcriptRevision).toBe(1);
  });

  it("accepts participant transcription 607 ms after agent completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    try {
      const active = advanceInterviewFinalization(liveAggregate("agent-delay"), {
        kind: "session_activity_observed",
        generation: 1,
        sequence: 1,
        at: 90,
      });
      const ending = receiveConversationReceipt(active.aggregate, {
        kind: "provider_finish_interview_observed",
        responseId: "agent-delay-response",
        callId: "agent-delay-call",
        generation: 1,
        sequence: 2,
        at: 100,
      });
      const committed = settleEffect(ending.aggregate, "close_input", 101);
      const admitted = advanceInterviewFinalization(committed, {
        kind: "participant_answer_created",
        itemId: "agent-delay-item",
        generation: 1,
        sequence: 3,
      });
      vi.setSystemTime(707);
      const terminal = advanceInterviewFinalization(admitted.aggregate, {
        kind: "participant_answer_transcribed",
        itemId: "agent-delay-item",
        text: "heard after agent completion",
        generation: 1,
        sequence: 4,
      });

      expect(terminal.aggregate.finalInput).toMatchObject({
        obligation: "settled",
        admittedItemId: "agent-delay-item",
        warning: null,
      });
      expect(terminal.aggregate.transcriptCapture.items).toContainEqual(
        expect.objectContaining({
          itemId: "agent-delay-item",
          text: "heard after agent completion",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits terminal transcription just before the nine-second drain checkpoint", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    try {
      const ending = end(liveAggregate("near-drain-deadline"));
      const committed = settleEffect(ending.aggregate, "close_input", 101);
      const admitted = advanceInterviewFinalization(committed, {
        kind: "participant_answer_created",
        itemId: "near-deadline-item",
        generation: 1,
        sequence: 1,
      });
      vi.setSystemTime(9_099);
      const terminal = advanceInterviewFinalization(admitted.aggregate, {
        kind: "participant_answer_transcribed",
        itemId: "near-deadline-item",
        text: "arrived in time",
        generation: 1,
        sequence: 2,
      });
      const closed = advanceInterviewFinalization(terminal.aggregate, {
        kind: "deadline_reached",
        deadline: "drain",
        at: 9_100,
      });

      // The settled transcription let the result freeze before the checkpoint.

      expect(closed.aggregate.state).toMatchObject({ stage: "finalizing", warnings: [] });
      expect(closed.aggregate.finalInput).toMatchObject({ obligation: "settled", warning: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an admitted item whose transcription never becomes terminal", () => {
    const ending = end(liveAggregate("never-terminal"));
    const committed = settleEffect(ending.aggregate, "close_input", 101);
    const admitted = advanceInterviewFinalization(committed, {
      kind: "participant_answer_created",
      itemId: "never-terminal-item",
      generation: 1,
      sequence: 1,
    });
    const bounded = advanceInterviewFinalization(admitted.aggregate, {
      kind: "deadline_reached",
      deadline: "finalization_cutoff",
      at: 10_100,
    });

    if (bounded.aggregate.state.stage !== "finalizing") {
      throw new Error("Expected the result to freeze at the finalization cutoff.");
    }
    expect(bounded.aggregate.state.warnings).toContain("drain_timed_out");
    expect(bounded.aggregate.state.warnings).toContain("final_input_may_be_incomplete");
  });

  it("contains a response created after the admission fence", () => {
    const ending = end(liveAggregate("response-after-fence"));
    const lateResponse = advanceInterviewFinalization(ending.aggregate, {
      kind: "reply_started",
      responseId: "late-response",
      generation: 1,
      sequence: 1,
    });
    const closing = advanceInterviewFinalization(lateResponse.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });

    expect(lateResponse.aggregate.state).toMatchObject({
      stage: "draining",
      warnings: [],
    });
    expect(lateResponse.effects).toContainEqual(
      expect.objectContaining({ kind: "cancel_reply", responseId: "late-response" }),
    );
    expect(closing.aggregate.state.effects).toContainEqual(
      expect.objectContaining({ kind: "cancel_reply", responseId: "late-response" }),
    );
  });

  it("distinguishes terminal close evidence across bounded order pairs", () => {
    const firstClosed = closingAggregate("provider-close-first");
    const closeObserved = advanceInterviewFinalization(firstClosed, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 2,
      at: 1_200,
    });
    const closeThenHangup = settleEffect(closeObserved.aggregate, "release_session", 1_201);

    const hangupFirst = closingAggregate("hangup-first");
    const acknowledged = settleEffect(hangupFirst, "release_session", 1_200);
    const hangupThenClose = advanceInterviewFinalization(acknowledged, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 2,
      at: 1_201,
    });

    const disconnected = advanceInterviewFinalization(closingAggregate("disconnect-only"), {
      kind: "runtime_failure_observed",
      source: "session_disconnected",
      at: 1_200,
    });
    const alreadyClosedAggregate = closingAggregate("already-closed");
    const alreadyClosedEffect = alreadyClosedAggregate.state.effects.find(
      ({ kind }) => kind === "release_session",
    );
    if (alreadyClosedEffect === undefined) throw new Error("Expected provider hangup effect.");
    const alreadyClosed = advanceInterviewFinalization(alreadyClosedAggregate, {
      kind: "effect_outcome",
      effectId: alreadyClosedEffect.id,
      outcome: { status: "dispatched", code: "session_closed" },
      at: 1_200,
    });

    expect(closeThenHangup.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: true,
    });
    expect(hangupThenClose.aggregate.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: true,
    });
    expect(acknowledged.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: false,
    });
    expect(disconnected.aggregate.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: false,
    });
    expect(alreadyClosed.aggregate.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: true,
    });
  });

  it("contains duplicate and late terminal transcription after settlement", () => {
    const ending = end(liveAggregate("duplicate-terminal"));
    const committed = settleEffect(ending.aggregate, "close_input", 101);
    const admitted = advanceInterviewFinalization(committed, {
      kind: "participant_answer_created",
      itemId: "admitted-item",
      generation: 1,
      sequence: 1,
    });
    const settled = advanceInterviewFinalization(admitted.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "admitted-item",
      text: "accepted text",
      generation: 1,
      sequence: 2,
    });
    const settledQuietDeadline = settled.aggregate.finalInput?.quietDeadline;
    const effectSequence = settled.aggregate.nextEffectSequence;
    const eventSequence = settled.aggregate.nextEventSequence;
    const duplicate = advanceInterviewFinalization(settled.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "admitted-item",
      text: "accepted text",
      generation: 1,
      sequence: 3,
    });
    const conflictingTerminal = advanceInterviewFinalization(duplicate.aggregate, {
      kind: "participant_answer_transcription_failed",
      itemId: "admitted-item",
      generation: 1,
      sequence: 4,
    });
    const late = advanceInterviewFinalization(conflictingTerminal.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "unrelated-late-item",
      text: "must not be captured",
      generation: 1,
      sequence: 5,
    });

    expect(duplicate.aggregate.transcriptRevision).toBe(settled.aggregate.transcriptRevision);
    expect(duplicate.aggregate.finalInput).toBe(settled.aggregate.finalInput);
    expect(duplicate.aggregate.finalInput?.quietDeadline).toBe(settledQuietDeadline);
    expect(conflictingTerminal.aggregate.finalInput).toBe(settled.aggregate.finalInput);
    if (conflictingTerminal.aggregate.state.stage !== "draining") {
      throw new Error("Expected duplicate terminal evidence to remain in draining.");
    }
    expect(conflictingTerminal.aggregate.state.warnings).not.toContain(
      "participant_transcription_failed",
    );
    expect(late.aggregate.transcriptRevision).toBe(settled.aggregate.transcriptRevision);
    expect(late.aggregate.nextEffectSequence).toBe(effectSequence);
    expect(late.aggregate.nextEventSequence).toBe(eventSequence);
    expect(late.aggregate.transcriptCapture.items).not.toContainEqual(
      expect.objectContaining({ itemId: "unrelated-late-item", text: "must not be captured" }),
    );
  });

  it("admits the queued prefix and freezes provider facts after the close barrier", () => {
    const ending = end(liveAggregate("close-barrier"));
    const committed = settleEffect(ending.aggregate, "close_input", 101);
    const admitted = advanceInterviewFinalization(committed, {
      kind: "participant_answer_created",
      itemId: "queued-item",
      generation: 1,
      sequence: 1,
    });
    const closing = advanceInterviewFinalization(admitted.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 9_100,
    });
    const queued = advanceInterviewFinalization(closing.aggregate, {
      kind: "participant_answer_transcribed",
      itemId: "queued-item",
      text: "queued before close",
      generation: 1,
      sequence: 2,
    });
    const providerClosed = advanceInterviewFinalization(queued.aggregate, {
      kind: "session_closed_observed",
      generation: 1,
      sequence: 3,
      at: 9_200,
    });
    const finalizing = settleEffect(providerClosed.aggregate, "release_session", 9_201);
    const revisionAtBarrier = finalizing.transcriptRevision;
    const afterBarrier = advanceInterviewFinalization(finalizing, {
      kind: "participant_answer_transcribed",
      itemId: "after-barrier-item",
      text: "too late",
      generation: 1,
      sequence: 4,
    });

    expect(queued.aggregate.transcriptCapture.items).toContainEqual(
      expect.objectContaining({ itemId: "queued-item", text: "queued before close" }),
    );
    expect(finalizing.state.stage).toBe("finalizing");
    expect(afterBarrier.aggregate.transcriptRevision).toBe(revisionAtBarrier);
    expect(afterBarrier.aggregate.transcriptCapture).toBe(finalizing.transcriptCapture);
  });
});

function liveAggregate(runId: string): InterviewFinalizationAggregate {
  return liveFinalizationAggregate({ runId });
}

function end(aggregate: InterviewFinalizationAggregate) {
  return advanceInterviewFinalization(aggregate, {
    kind: "end_requested",
    reason: "participant_stopped",
    source: "browser_request",
    at: 100,
  });
}

function settleEffect(
  aggregate: InterviewFinalizationAggregate,
  kind: "close_input" | "release_session",
  at: number,
): InterviewFinalizationAggregate {
  const effect = aggregate.state.effects.find((candidate) => candidate.kind === kind);
  if (effect === undefined) throw new Error(`Expected ${kind} effect.`);
  return advanceInterviewFinalization(aggregate, {
    kind: "effect_outcome",
    effectId: effect.id,
    outcome: { status: "dispatched" },
    at,
  }).aggregate;
}

/** Provider cleanup has begun while the admitted final item's text is still owed. */

function closingAggregate(runId: string): InterviewFinalizationAggregate {
  const ending = end(liveAggregate(runId));
  const committed = settleEffect(ending.aggregate, "close_input", 101);
  const admitted = advanceInterviewFinalization(committed, {
    kind: "participant_answer_created",
    itemId: `${runId}-final-item`,
    generation: 1,
    sequence: 1,
  }).aggregate;
  return advanceInterviewFinalization(admitted, {
    kind: "deadline_reached",
    deadline: "drain",
    at: 9_100,
  }).aggregate;
}
