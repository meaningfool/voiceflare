import { describe, expect, it } from "vitest";
import {
  liveFinalizationAggregate,
  receiveConversationReceipt,
} from "./testing/finalizationFixtures.ts";
import { advanceInterviewFinalization } from "./interviewFinalizationFSM.ts";
import {
  readFinalizationTranscriptTurns,
  type InterviewFinalizationAggregate,
  type FinalizationObservation,
} from "./interviewFinalizationModel.ts";
import { decodeInterviewFinalizationAggregate } from "./interviewFinalizationPersistenceDecoder.ts";
import { createRuntimeTranscriptSnapshot } from "../shared/runtimeTranscriptSnapshot.ts";
import { parseRuntimeTerminalResult } from "../shared/contracts/runtimeTerminalResult.ts";
import { createRuntimeUsageAccounting } from "./runtimeUsage.ts";

function live(): InterviewFinalizationAggregate {
  return {
    ...liveFinalizationAggregate({ runId: "interrupted-run" }),
    providerGeneration: 1,
    runtimeUsage: createRuntimeUsageAccounting(),
    applicationTranscriptProof: {
      liveAt: 100,
      interrupted: false,
      obligations: [],
      closeBarrier: null,
      result: null,
    },
  };
}
function step(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservation,
): InterviewFinalizationAggregate {
  // A native finish receipt reaches finalization only as Conversation evidence.
  const next = (
    observation.kind === "provider_finish_interview_observed" ||
    observation.kind === "provider_finish_interview_rejected"
      ? receiveConversationReceipt(aggregate, observation)
      : advanceInterviewFinalization(aggregate, observation)
  ).aggregate;
  expect(decodeInterviewFinalizationAggregate(JSON.stringify(next))).toEqual(next);
  return next;
}
function input(
  aggregate: InterviewFinalizationAggregate,
  sequence = 1,
): InterviewFinalizationAggregate {
  return step(aggregate, {
    kind: "participant_answer_created",
    itemId: "participant",
    generation: 1,
    sequence,
  });
}
function text(
  aggregate: InterviewFinalizationAggregate,
  sequence = 2,
): InterviewFinalizationAggregate {
  return step(aggregate, {
    kind: "participant_answer_transcribed",
    itemId: "participant",
    text: "My feedback",
    generation: 1,
    sequence,
  });
}
function interrupt(aggregate: InterviewFinalizationAggregate): InterviewFinalizationAggregate {
  return step(aggregate, {
    kind: "runtime_failure_observed",
    source: "session_disconnected",
    at: 200,
  });
}
async function seal(
  aggregate: InterviewFinalizationAggregate,
): Promise<InterviewFinalizationAggregate> {
  let next = aggregate;
  if (next.state.stage === "live" || next.state.stage === "ended") {
    throw new Error("Expected ending state.");
  }
  const cutoff = next.state.finalizationCutoffAt;
  for (const effect of next.state.effects) {
    if (effect.status === "pending")
      next = step(next, {
        kind: "effect_outcome",
        effectId: effect.id,
        outcome: { status: "dispatched" },
        at: 201,
      });
  }
  if (next.state.stage === "draining" || next.state.stage === "closing_provider") {
    next = step(next, {
      kind: "deadline_reached",
      deadline: "finalization_cutoff",
      at: cutoff,
    });
  }
  if (next.state.stage === "ended") return next;
  const snapshot = await createRuntimeTranscriptSnapshot(next.transcriptRevision, {
    turns: readFinalizationTranscriptTurns(next),
  });
  next = step(next, {
    kind: "transcript_digest_computed",
    revision: snapshot.revision,
    digest: snapshot.digest,
    at: cutoff + 1,
  });
  expect(next.state.stage).toBe("ended");
  return next;
}

describe("Application interruption Transcript proof", () => {
  it("seals a captured prefix as complete despite continuity and close diagnostics", async () => {
    const ended = await seal(interrupt(text(input(live()))));
    expect(ended.applicationTranscriptProof?.result).toMatchObject({
      outcome: "interrupted",
      liveAt: 100,
      endedAt: 200,
      transcriptCompleteness: "complete",
      transcriptSnapshot: { turnCount: 1 },
    });
    expect(readFinalizationTranscriptTurns(ended)).toEqual([
      { role: "participant", text: "My feedback" },
    ]);
  });
  it("proves an empty complete Transcript when no input or eligible turn existed", async () => {
    const ended = await seal(interrupt(live()));
    expect(ended.applicationTranscriptProof?.result).toMatchObject({
      transcriptCompleteness: "complete",
      transcriptSnapshot: { turnCount: 0 },
    });
  });
  it("persists unresolved proof and seals incomplete at the existing bound", async () => {
    const ending = interrupt(input(live()));
    expect(ending.applicationTranscriptProof?.obligations).toEqual([
      { itemId: "participant", role: "participant", status: "pending" },
    ]);
    const restored = decodeInterviewFinalizationAggregate(JSON.stringify(ending));
    if (restored === null) throw new Error("Expected durable proof");
    const ended = await seal(restored);
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("incomplete");
  });
  it("cannot certify a final Transcript event that supplies no final text", async () => {
    const missing = step(live(), {
      kind: "agent_transcript_finalized",
      itemId: "missing-text",
      generation: 1,
      sequence: 1,
    });
    const ended = await seal(interrupt(missing));
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("incomplete");
  });
  it("keeps known transcription failure incomplete even after the active input clears", async () => {
    const failed = step(input(live()), {
      kind: "participant_answer_transcription_failed",
      itemId: "participant",
      generation: 1,
      sequence: 2,
    });
    const ended = await seal(interrupt(failed));
    expect(ended.applicationTranscriptProof?.obligations[0]?.status).toBe("failed");
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("incomplete");
    expect(ended.applicationTranscriptProof?.result?.transcriptIncompleteReasons).toEqual([
      {
        kind: "eligible_transcript_item_failed",
        itemId: "participant",
        role: "participant",
      },
    ]);
  });
  it("admits selected terminal input after the presence deadline without extending endedAt", async () => {
    let ending = step(input(live()), {
      kind: "deadline_reached",
      deadline: "presence_grace",
      at: 200,
    });
    ending = text(ending);
    const ended = await seal(ending);
    expect(ended.applicationTranscriptProof?.result).toMatchObject({
      endedAt: 200,
      transcriptCompleteness: "complete",
      transcriptSnapshot: { turnCount: 1 },
    });
  });
  it("tracks a newly admitted final item until it settles", async () => {
    let ending = step(live(), { kind: "deadline_reached", deadline: "presence_grace", at: 200 });
    ending = input(ending);
    expect(ending.applicationTranscriptProof?.obligations[0]?.status).toBe("pending");
    const ended = await seal(ending);
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("incomplete");
  });
  it("fences a Runtime-failure end request through the same reducer", () => {
    const ending = step(input(live()), {
      kind: "end_requested",
      reason: "runtime_failed",
      source: "runtime_failure",
      at: 200,
    });
    expect(text(ending)).toEqual(ending);
  });
  it("does not admit unrelated output or final text after direct continuity loss", async () => {
    const ending = interrupt(input(live()));
    expect(text(ending)).toEqual(ending);
    const replayed = step(ending, {
      kind: "participant_answer_transcribed",
      itemId: "participant",
      text: "Late replay",
      generation: 2,
      sequence: 1,
    });
    expect(readFinalizationTranscriptTurns(replayed)).toEqual([]);
    const ended = await seal(replayed);
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("incomplete");
    expect(text(ended, 100)).toEqual(ended);
  });
  it("preserves the expected-completion winner after interruption and presence expiry", async () => {
    let ending = step(live(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 150,
    });
    ending = interrupt(ending);
    ending = step(ending, { kind: "deadline_reached", deadline: "presence_grace", at: 200 });
    const ended = await seal(ending);
    expect(ended.applicationTranscriptProof?.result).toMatchObject({
      outcome: "completed",
      reason: "participant_stopped",
      endedAt: 150,
    });
    expect(ended.state).toMatchObject({
      completion: { endReason: "participant_stopped", endedAt: 150 },
    });
  });
  it("uses accepted Ending entry when reconstruction has no durable provider observation", async () => {
    const reconstructed = step(live(), {
      kind: "runtime_failure_observed",
      source: "session_disconnected",
      at: 200,
    });
    expect((await seal(reconstructed)).applicationTranscriptProof?.result?.endedAt).toBe(200);
  });
  it("keeps the durable observation while anchoring an immutable cutoff to accepted Ending", async () => {
    const observed = step(live(), {
      kind: "session_activity_observed",
      generation: 1,
      sequence: 1,
      at: 140,
    });
    expect(observed.lastProviderObservationAt).toBe(140);
    const duplicate = step(observed, {
      kind: "session_activity_observed",
      generation: 1,
      sequence: 1,
      at: 160,
    });
    expect(duplicate).toEqual(observed);
    const reconstructed = step(observed, {
      kind: "runtime_failure_observed",
      source: "session_disconnected",
      at: 190,
    });
    const late = step(reconstructed, {
      kind: "session_activity_observed",
      generation: 2,
      sequence: 2,
      at: 195,
    });
    expect(late).toEqual(reconstructed);
    const ended = await seal(late);
    expect(ended.applicationTranscriptProof?.result).toMatchObject({
      endedAt: 190,
      transcriptCompleteness: "complete",
    });
    expect(ended.lastProviderObservationAt).toBe(140);
  });

  it.each([-1, 99, 1.5, "140", null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid durable observation time %s",
    (lastProviderObservationAt) => {
      expect(
        decodeInterviewFinalizationAggregate(
          JSON.stringify({ ...live(), lastProviderObservationAt }),
        ),
      ).toBeNull();
    },
  );

  it("owns the reconstructed cutoff and rejects inherited or unknown persistence fields", () => {
    const aggregate = { ...live(), lastProviderObservationAt: 140 };
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
    expect(decodeInterviewFinalizationAggregate({ ...aggregate, unknown: true })).toBeNull();
    expect(() => decodeInterviewFinalizationAggregate(Object.create(aggregate))).toThrow();
    const owned = decodeInterviewFinalizationAggregate(aggregate);
    aggregate.lastProviderObservationAt = 180;
    expect(owned?.lastProviderObservationAt).toBe(140);
  });

  it.each(["completion", "snapshot"] as const)(
    "rejects unknown persisted terminal %s fields",
    async (scope) => {
      const ended = await seal(interrupt(live()));
      if (ended.state.stage !== "ended") throw new Error("Expected ended state");
      const completion = ended.state.completion;
      const raw = {
        ...ended,
        state: {
          ...ended.state,
          completion:
            scope === "completion"
              ? { ...completion, unexpected: true }
              : {
                  ...completion,
                  transcriptSnapshot: { ...completion.transcriptSnapshot, unexpected: true },
                },
        },
      };
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(raw))).toBeNull();
    },
  );

  it.each(["runtime_failure_observed", "session_closed_observed"] as const)(
    "interrupts on %s",
    async (kind) => {
      const ending = step(
        live(),
        kind === "runtime_failure_observed"
          ? { kind, source: "session_message_failure", at: 200 }
          : { kind, generation: 1, sequence: 1, at: 200 },
      );
      expect((await seal(ending)).applicationTranscriptProof?.result?.outcome).toBe("interrupted");
    },
  );
  it("records conclusive non-Transcript evidence separately from captured text", async () => {
    const observed = step(live(), {
      kind: "transcript_item_observed",
      itemId: "tool",
      role: "conversationAgent",
      nonTranscript: true,
      generation: 1,
      sequence: 1,
    });
    const ended = await seal(interrupt(observed));
    expect(ended.applicationTranscriptProof?.obligations).toEqual([
      { itemId: "tool", role: "conversationAgent", status: "non_transcript" },
    ]);
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("complete");
  });
  it("keeps nonselected output outside a presence fence while accepting the selected tail", async () => {
    let ending = step(input(live()), {
      kind: "deadline_reached",
      deadline: "presence_grace",
      at: 200,
    });
    ending = step(ending, {
      kind: "agent_transcript_finalized",
      itemId: "late-agent",
      text: "Ineligible",
      generation: 1,
      sequence: 2,
    });
    ending = text(ending, 3);
    const duplicate = text(ending, 3);
    expect(duplicate).toEqual(ending);
    const ended = await seal(ending);
    expect(readFinalizationTranscriptTurns(ended)).toEqual([
      { role: "participant", text: "My feedback" },
    ]);
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("complete");
  });
  it("persists input the closure was to settle, left unanswered, as unresolved terminal-tail proof", async () => {
    const ending = interrupt(live());
    const commandId = ending.finalInput?.effectId;
    if (commandId === undefined) throw new Error("Expected final input obligation");
    // The execution reports that the participant gave input the step settles, and answers it.
    const unanswered = step(ending, {
      kind: "effect_outcome",
      effectId: commandId,
      outcome: {
        status: "dispatched",
        settlement: { supersedesHeld: false, answerFollows: true, inputToSettle: true },
      },
      at: 201,
    });
    const ended = await seal(unanswered);
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("incomplete");
    expect(ended.applicationTranscriptProof?.result?.transcriptIncompleteReasons).toEqual([
      { kind: "final_input_unresolved" },
    ]);
  });
  it("accepts the input closure's nothing-to-settle answer without inventing a turn", async () => {
    const active = step(live(), {
      kind: "session_activity_observed",
      generation: 1,
      sequence: 1,
      at: 150,
    });
    let ending = step(active, { kind: "deadline_reached", deadline: "presence_grace", at: 200 });
    const commandId = ending.finalInput?.effectId;
    if (commandId === undefined) throw new Error("Expected final input obligation");
    ending = step(ending, { kind: "nothing_to_settle", commandId, generation: 1, sequence: 2 });
    const ended = await seal(ending);
    expect(ended.applicationTranscriptProof?.result).toMatchObject({
      transcriptCompleteness: "complete",
      transcriptSnapshot: { turnCount: 0 },
    });
  });
  it("keeps the expected agent completion ahead of code 1006", async () => {
    const ending = step(live(), {
      kind: "provider_finish_interview_observed",
      responseId: "closing",
      callId: "finish",
      generation: 1,
      sequence: 1,
      at: 150,
    });
    const interrupted = step(ending, {
      kind: "runtime_failure_observed",
      source: "session_disconnected",
      at: 200,
    });
    const ended = await seal(interrupted);
    expect(ended.applicationTranscriptProof?.result).toMatchObject({
      outcome: "completed",
      reason: "agent_requested_end",
      endedAt: 150,
      transcriptCompleteness: "incomplete",
    });
    expect(ended.state).toMatchObject({
      completion: { endReason: "agent_requested_end", endedAt: 150 },
    });
  });
  it("rejects corrupted proof and snapshot certification instead of repairing them", async () => {
    const ended = await seal(interrupt(text(input(live()))));
    const proof = ended.applicationTranscriptProof;
    if (proof?.result === null || proof === undefined) throw new Error("Expected result");
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({ ...ended, applicationTranscriptProof: { ...proof, unexpected: true } }),
      ),
    ).toBeNull();
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({
          ...ended,
          applicationTranscriptProof: {
            ...proof,
            result: {
              ...proof.result,
              transcriptSnapshot: { ...proof.result.transcriptSnapshot, revision: 99 },
            },
          },
        }),
      ),
    ).toBeNull();
    // A Live Run has not sealed a result.
    const unsealed = live();
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({
          ...unsealed,
          applicationTranscriptProof: {
            ...unsealed.applicationTranscriptProof,
            result: proof.result,
          },
        }),
      ),
    ).toBeNull();
    expect(parseRuntimeTerminalResult({ ...proof.result, endReason: "runtime_failed" })).toBeNull();
    expect(
      parseRuntimeTerminalResult({ ...proof.result, transcriptCompleteness: "pending" }),
    ).toBeNull();
    expect(parseRuntimeTerminalResult({ ...proof.result, liveAt: 201 })).toBeNull();
    const missing = { ...proof.result, runId: undefined };
    expect(parseRuntimeTerminalResult(missing)).toBeNull();
    expect(parseRuntimeTerminalResult({ ...proof.result, endedAt: "200" })).toBeNull();
    expect(
      parseRuntimeTerminalResult({
        ...proof.result,
        transcriptSnapshot: { ...proof.result.transcriptSnapshot, turnCount: "1" },
      }),
    ).toBeNull();
    expect(parseRuntimeTerminalResult(Object.create(proof.result))).toBeNull();
    const inheritedSnapshot: unknown = Object.create(proof.result.transcriptSnapshot);
    expect(
      parseRuntimeTerminalResult({
        ...proof.result,
        transcriptSnapshot: inheritedSnapshot,
      }),
    ).toBeNull();
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({
          ...ended,
          applicationTranscriptProof: {
            ...proof,
            obligations: [{ itemId: "participant", role: "participant", status: 42 }],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({ ...ended, applicationTranscriptProof: { ...proof, liveAt: "100" } }),
      ),
    ).toBeNull();
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({ ...ended, applicationTranscriptProof: { ...proof, liveAt: undefined } }),
      ),
    ).toBeNull();
    const mutable = structuredClone(proof.result);
    const parsed = parseRuntimeTerminalResult(mutable);
    mutable.transcriptSnapshot.revision = 999;
    expect(parsed).toEqual(proof.result);
  });
});

describe("current interviewer turn", () => {
  function selectedTurn(): InterviewFinalizationAggregate {
    let aggregate = live();
    aggregate = step(aggregate, {
      kind: "reply_started",
      responseId: "current",
      generation: 1,
      sequence: 1,
      observedAt: 120,
    });
    aggregate = step(aggregate, {
      kind: "reply_delivery_started",
      responseId: "current",
      generation: 1,
      sequence: 2,
      observedAt: 150,
    });
    return aggregate;
  }
  function finalText(
    aggregate: InterviewFinalizationAggregate,
    sequence: number,
    observedAt = 9_700,
  ) {
    return step(aggregate, {
      kind: "agent_transcript_finalized",
      responseId: "current",
      itemId: "question",
      text: "What should we improve next?",
      generation: 1,
      sequence,
      observedAt,
    });
  }
  function end(
    aggregate: InterviewFinalizationAggregate,
    reason: "participant_stopped" | "timebox_reached",
  ) {
    return step(aggregate, { kind: "end_requested", reason, source: "test", at: 200 });
  }
  it.each(["participant_stopped", "timebox_reached"] as const)(
    "retains matching final text before and after %s exactly once",
    async (reason) => {
      for (const receiptOrder of ["before", "after"] as const) {
        let aggregate = selectedTurn();
        if (receiptOrder === "before") {
          aggregate = finalText(aggregate, 3, 150);
          aggregate = step(aggregate, {
            kind: "reply_generated",
            responseId: "current",
            generation: 1,
            sequence: 4,
            observedAt: 160,
          });
        }
        aggregate = end(aggregate, reason);
        expect(aggregate.retainedInterviewerResponseId).toBe("current");
        // A repeat End after reconstruction retains selection, reason and the original cutoff.
        const restored = decodeInterviewFinalizationAggregate(JSON.stringify(aggregate));
        if (restored === null) throw new Error("Expected retained turn recovery");
        aggregate = step(restored, {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "repeat",
          at: 500,
        });
        expect(aggregate.state).toMatchObject({
          endReason: reason,
          endingStartedAt: 200,
          finalizationCutoffAt: 10_200,
        });
        if (receiptOrder === "after") {
          aggregate = step(aggregate, {
            kind: "reply_cancelled",
            responseId: "current",
            generation: 1,
            sequence: 3,
            observedAt: 250,
          });
          aggregate = step(aggregate, { kind: "deadline_reached", deadline: "drain", at: 9_200 });
          expect(aggregate.state.stage).toBe("closing_provider");
          aggregate = finalText(aggregate, 4);
        }
        aggregate = step(aggregate, {
          kind: "agent_transcript_finalized",
          responseId: "later",
          itemId: "new-question",
          text: "Must stay excluded",
          generation: 1,
          sequence: 5,
          observedAt: 9_800,
        });
        aggregate = finalText(aggregate, 6);
        const ended = await seal(aggregate);
        expect(readFinalizationTranscriptTurns(ended)).toEqual([
          { role: "conversationAgent", text: "What should we improve next?" },
        ]);
        expect(ended.state).toMatchObject({
          completion: {
            endReason: reason,
            endedAt: 200,
            finalizationCutoffAt: 10_200,
            transcriptSnapshot: { turnCount: 1 },
          },
        });
        expect(ended.applicationTranscriptProof.result).toMatchObject({
          outcome: "completed",
          reason,
          transcriptCompleteness: "complete",
        });
        expect(finalText(ended, 100)).toEqual(ended);
      }
    },
  );
  it.each(["participant_stopped", "timebox_reached"] as const)(
    "bounds missing selected final text after %s without changing the result reason",
    async (reason) => {
      let aggregate = end(selectedTurn(), reason);
      aggregate = step(aggregate, {
        kind: "reply_cancelled",
        responseId: "current",
        generation: 1,
        sequence: 3,
        observedAt: 250,
      });
      aggregate = step(aggregate, { kind: "deadline_reached", deadline: "drain", at: 9_200 });
      expect(aggregate.state).toMatchObject({
        stage: "closing_provider",
        finalizationCutoffAt: 10_200,
      });
      aggregate = step(aggregate, {
        kind: "deadline_reached",
        deadline: "finalization_cutoff",
        at: 10_200,
      });
      const ended = await seal(aggregate);
      expect(readFinalizationTranscriptTurns(ended)).toEqual([]);
      expect(ended.state).toMatchObject({
        completion: { endReason: reason, endedAt: 200, finalizationCutoffAt: 10_200 },
      });
      expect(ended.applicationTranscriptProof.result).toMatchObject({
        outcome: "completed",
        reason,
        transcriptCompleteness: "incomplete",
        transcriptIncompleteReasons: [{ kind: "conversation_evidence_gap" }],
      });
      expect(finalText(ended, 100)).toEqual(ended);
    },
  );
  it("waits for every known text item, while non-Transcript output cannot delay early completion", async () => {
    let aggregate = selectedTurn();
    for (const [index, itemId] of ["question", "second-part", "tool"].entries()) {
      aggregate = step(aggregate, {
        kind: "transcript_item_observed",
        itemId,
        responseId: "current",
        role: "conversationAgent",
        nonTranscript: itemId === "tool",
        generation: 1,
        sequence: index + 3,
      });
    }
    aggregate = end(aggregate, "participant_stopped");
    aggregate = step(aggregate, {
      kind: "reply_cancelled",
      responseId: "current",
      generation: 1,
      sequence: 6,
    });
    const commit = aggregate.state.effects.find((effect) => effect.kind === "close_input");
    if (commit === undefined) throw new Error("Expected final input commit");
    aggregate = step(aggregate, {
      kind: "effect_outcome",
      effectId: commit.id,
      outcome: { status: "benign_rejection" },
      at: 250,
    });
    aggregate = step(aggregate, { kind: "deadline_reached", deadline: "drain", at: 1_200 });
    aggregate = finalText(aggregate, 7);
    expect(aggregate.state.stage).toBe("draining");
    aggregate = step(aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "tool",
      responseId: "current",
      text: "Contradictory non-Transcript output stays excluded",
      generation: 1,
      sequence: 8,
      observedAt: 9_750,
    });
    aggregate = step(aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "second-part",
      responseId: "current",
      text: "Please give an example.",
      generation: 1,
      sequence: 9,
      observedAt: 9_800,
    });
    expect(aggregate.state.stage).toBe("finalizing");
    const ended = await seal(aggregate);
    expect(readFinalizationTranscriptTurns(ended)).toEqual([
      { role: "conversationAgent", text: "What should we improve next?" },
      { role: "conversationAgent", text: "Please give an example." },
    ]);
  });
  it.each(["participant_stopped", "timebox_reached"] as const)(
    "settles conclusive non-Transcript output after %s without certifying an unknown inventory",
    async (reason) => {
      for (const inventory of ["non-transcript", "unknown", "empty", "cancelled"] as const) {
        let aggregate = live();
        aggregate = step(aggregate, {
          kind: "reply_started",
          responseId: "current",
          generation: 1,
          sequence: 1,
          observedAt: 120,
        });
        aggregate = end(aggregate, reason);
        const transcriptItems =
          inventory === "empty"
            ? []
            : [
                {
                  itemId: "tool",
                  responseId: "current",
                  role: "conversationAgent" as const,
                  nonTranscript: true,
                },
              ];
        const terminal = {
          responseId: "current",
          transcriptInventoryComplete: inventory !== "unknown",
          transcriptItems,
          generation: 1,
          sequence: 2,
          observedAt: 250,
        };
        aggregate = step(
          aggregate,
          inventory === "cancelled"
            ? { ...terminal, kind: "reply_cancelled" }
            : { ...terminal, kind: "reply_generated", status: "completed" },
        );
        const commit = aggregate.state.effects.find((effect) => effect.kind === "close_input");
        if (commit === undefined) throw new Error("Expected final input commit");
        aggregate = step(aggregate, {
          kind: "effect_outcome",
          effectId: commit.id,
          outcome: { status: "benign_rejection" },
          at: 260,
        });
        aggregate = step(aggregate, { kind: "deadline_reached", deadline: "drain", at: 1_200 });
        expect(aggregate.state.stage).toBe(
          inventory === "non-transcript" ? "finalizing" : "draining",
        );
        const ended = await seal(aggregate);
        expect(readFinalizationTranscriptTurns(ended)).toEqual([]);
        expect(ended.state).toMatchObject({
          completion: { endReason: reason, endedAt: 200, finalizationCutoffAt: 10_200 },
        });
        expect(ended.applicationTranscriptProof.result).toMatchObject({
          outcome: "completed",
          reason,
          transcriptCompleteness: inventory === "non-transcript" ? "complete" : "incomplete",
        });
      }
    },
  );
  it("rejects invalid retained-response persistence rather than widening admission", () => {
    const aggregate = end(selectedTurn(), "participant_stopped");
    for (const responseId of [42, "", "later", null])
      expect(
        decodeInterviewFinalizationAggregate(
          JSON.stringify({ ...aggregate, retainedInterviewerResponseId: responseId }),
        ),
      ).toBeNull();
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({ ...selectedTurn(), retainedInterviewerResponseId: "current" }),
      ),
    ).toBeNull();
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({
          ...aggregate,
          transcriptCapture: {
            sequence: 1,
            items: [{ itemId: "tool", firstSeenSequence: 1, nonTranscript: 42 }],
          },
        }),
      ),
    ).toBeNull();
    for (const marker of [42, false, true, null])
      expect(
        decodeInterviewFinalizationAggregate(
          JSON.stringify({
            ...aggregate,
            providerResponses: [
              {
                responseId: "current",
                status: "active",
                outputAudio: "active",
                nonTranscriptInventoryComplete: marker,
              },
            ],
          }),
        ),
      ).toBeNull();
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({
          ...end(selectedTurn(), "participant_stopped"),
          state: { ...aggregate.state, endReason: "runtime_failed" },
        }),
      ),
    ).toBeNull();
  });
});
