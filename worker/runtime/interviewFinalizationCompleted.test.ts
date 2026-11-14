import { describe, expect, it } from "vitest";
import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";
import { advanceInterviewFinalization } from "./interviewFinalizationFSM.ts";
import {
  drainCheckpointAt,
  readFinalizationTranscriptTurns,
  type InterviewFinalizationAggregate,
  type FinalizationInput,
} from "./interviewFinalizationModel.ts";
import { decodeInterviewFinalizationAggregate } from "./interviewFinalizationPersistenceDecoder.ts";
import { createRuntimeTranscriptSnapshot } from "../shared/runtimeTranscriptSnapshot.ts";
import { parseCompletedResult } from "../shared/contracts/runtimeTerminalResult.ts";
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
  observation: FinalizationInput,
): InterviewFinalizationAggregate {
  const next = advanceInterviewFinalization(aggregate, observation).aggregate;
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

async function seal(
  aggregate: InterviewFinalizationAggregate,
  afterBound?: (aggregate: InterviewFinalizationAggregate) => InterviewFinalizationAggregate,
  digestAt?: number,
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
  if (next.state.stage === "draining") {
    next = step(next, {
      kind: "deadline_reached",
      deadline: "finalization_cutoff",
      at: cutoff,
    });
  }
  if (afterBound !== undefined) next = afterBound(next);
  if (next.state.stage === "ended") return next;
  const snapshot = await createRuntimeTranscriptSnapshot(next.transcriptRevision, {
    turns: readFinalizationTranscriptTurns(next),
  });
  next = step(next, {
    kind: "transcript_digest_computed",
    revision: snapshot.revision,
    digest: snapshot.digest,
    at: digestAt ?? cutoff + 1,
  });
  expect(next.state.stage).toBe("ended");
  return next;
}

describe.each(["participant_stopped", "timebox_reached"] as const)(
  "Application completed proof: %s",
  (reason) => {
    function stop(aggregate: InterviewFinalizationAggregate) {
      return step(aggregate, { kind: "end_requested", reason, source: "browser_request", at: 200 });
    }
    it("waits for eligible final text after the winning end time and seals it atomically", async () => {
      const pending = stop(input(live()));
      expect(pending.state.stage).toBe("draining");
      const captured = text(pending);
      expect(text(captured)).toEqual(captured);
      const ended = await seal(captured);
      expect(ended.applicationTranscriptProof?.result).toMatchObject({
        outcome: "completed",
        reason,
        liveAt: 100,
        endedAt: 200,
        transcriptCompleteness: "complete",
        transcriptSnapshot: { turnCount: 1 },
      });
      expect(readFinalizationTranscriptTurns(ended)).toEqual([
        { role: "participant", text: "My feedback" },
      ]);
      expect(text(ended, 100)).toEqual(ended);
    });
    it("certifies unresolved and failed transcription as incomplete across reconstruction", async () => {
      for (const failed of [false, true]) {
        let pending = stop(input(live()));
        if (failed)
          pending = step(pending, {
            kind: "participant_answer_transcription_failed",
            itemId: "participant",
            generation: 1,
            sequence: 2,
          });
        const restored = decodeInterviewFinalizationAggregate(JSON.stringify(pending));
        if (restored === null) throw new Error("missing_restored_proof");
        const ended = await seal(restored);
        expect(ended.applicationTranscriptProof?.result).toMatchObject({
          outcome: "completed",
          reason,
          endedAt: 200,
          transcriptCompleteness: "incomplete",
          transcriptIncompleteReasons: [
            {
              kind: failed ? "eligible_transcript_item_failed" : "eligible_transcript_item_pending",
              itemId: "participant",
              role: "participant",
            },
          ],
        });
      }
    });
    it("certifies empty and assistant-only frozen text from eligible obligations", async () => {
      for (const assistant of [false, true]) {
        let aggregate = live();
        if (assistant)
          aggregate = step(aggregate, {
            kind: "agent_transcript_finalized",
            itemId: "assistant",
            text: "Welcome",
            generation: 1,
            sequence: 1,
          });
        const ended = await seal(stop(aggregate));
        expect(ended.applicationTranscriptProof?.result).toMatchObject({
          transcriptCompleteness: "complete",
          transcriptSnapshot: { turnCount: assistant ? 1 : 0 },
        });
      }
    });
    it("keeps the first reason and time after conflicting stop, failure and code 1006", async () => {
      let pending = stop(text(input(live())));
      pending = step(pending, {
        kind: "end_requested",
        reason: reason === "participant_stopped" ? "timebox_reached" : "participant_stopped",
        source: "browser_request",
        at: 300,
      });
      pending = step(pending, { kind: "runtime_failure_observed", source: "test", at: 400 });
      pending = step(pending, {
        kind: "runtime_failure_observed",
        source: "session_disconnected",
        at: 500,
      });
      const ended = await seal(pending);
      expect(ended.applicationTranscriptProof?.result).toMatchObject({
        outcome: "completed",
        reason,
        endedAt: 200,
        transcriptCompleteness: "complete",
      });
    });
    it("excludes unrelated content and text first observed after the finalization bound", async () => {
      let ending = stop(input(live()));
      ending = step(ending, {
        kind: "participant_answer_transcribed",
        itemId: "unrelated",
        text: "After the fence",
        generation: 1,
        sequence: 2,
      });
      const ended = await seal(ending, (bounded) => {
        expect(bounded.state.stage).toBe("finalizing");
        return text(bounded, 3);
      });
      expect(text(ended, 3)).toEqual(ended);
      expect(readFinalizationTranscriptTurns(ended)).toEqual([]);
      expect(ended.applicationTranscriptProof?.result).toMatchObject({
        outcome: "completed",
        reason,
        transcriptCompleteness: "incomplete",
      });
    });

    it("accepts evidence immediately before the cutoff and rejects evidence at the cutoff", () => {
      const before = stop(input(live()));
      if (before.state.stage !== "draining") throw new Error("expected_draining");
      const cutoff = before.state.finalizationCutoffAt;
      const accepted = step(before, {
        kind: "participant_answer_transcribed",
        itemId: "participant",
        text: "Before the cutoff",
        generation: 1,
        sequence: 2,
        observedAt: cutoff - 1,
      });
      expect(readFinalizationTranscriptTurns(accepted)).toEqual([
        { role: "participant", text: "Before the cutoff" },
      ]);

      const rejected = step(stop(input(live())), {
        kind: "participant_answer_transcribed",
        itemId: "participant",
        text: "At the cutoff",
        generation: 1,
        sequence: 2,
        observedAt: cutoff,
      });
      expect(rejected.state.stage).toBe("finalizing");
      expect(readFinalizationTranscriptTurns(rejected)).toEqual([]);
    });

    it("keeps the nine-second checkpoint and provider closure from bounding pending evidence", () => {
      let ending = stop(input(live()));
      if (ending.state.stage !== "draining") throw new Error("expected_draining");
      const cutoff = ending.state.finalizationCutoffAt;
      const drainDeadline = drainCheckpointAt(ending.state);
      for (const effect of ending.state.effects) {
        if (effect.status === "pending") {
          ending = step(ending, {
            kind: "effect_outcome",
            effectId: effect.id,
            outcome: { status: "dispatched" },
            at: 201,
          });
        }
      }
      const checkpoint = step(ending, {
        kind: "deadline_reached",
        deadline: "drain",
        at: drainDeadline,
      });
      expect(checkpoint.state).toMatchObject({
        stage: "closing_provider",
        finalizationCutoffAt: cutoff,
      });
      expect(checkpoint.finalInput?.obligation).toBe("awaiting_transcription");
      expect(checkpoint.applicationTranscriptProof?.obligations).toContainEqual({
        itemId: "participant",
        role: "participant",
        status: "pending",
      });
      const cutoffWithPendingHangup = step(checkpoint, {
        kind: "deadline_reached",
        deadline: "finalization_cutoff",
        at: cutoff,
      });
      expect(cutoffWithPendingHangup.state.stage).toBe("finalizing");
      expect(
        cutoffWithPendingHangup.state.effects.find((effect) => effect.kind === "release_session"),
      ).toMatchObject({ status: "pending" });

      const closed = step(checkpoint, {
        kind: "session_closed_observed",
        generation: 1,
        sequence: 2,
        at: cutoff - 2,
        observedAt: cutoff - 2,
      });
      expect(closed.state.stage).toBe("closing_provider");
      expect(closed.applicationTranscriptProof?.result).toBeNull();

      const frozen = step(closed, {
        kind: "deadline_reached",
        deadline: "finalization_cutoff",
        at: cutoff,
      });
      expect(frozen.state.stage).toBe("finalizing");
      expect(frozen.applicationTranscriptProof?.result).toBeNull();
    });

    it("keeps the original cutoff when digest work resumes after an outage", async () => {
      const ending = stop(text(input(live())));
      if (ending.state.stage === "live" || ending.state.stage === "ended") {
        throw new Error("expected_ending");
      }
      const cutoff = ending.state.finalizationCutoffAt;
      const ended = await seal(ending, undefined, cutoff + 5_000);
      expect(ended.state).toMatchObject({
        stage: "ended",
        completion: {
          endedAt: 200,
          finalizationCutoffAt: cutoff,
          finalizedAt: cutoff + 5_000,
        },
      });
    });

    it("rejects invalid result fields and returns an independent JSON-owned result", async () => {
      const ended = await seal(stop(text(input(live()))));
      const result = ended.applicationTranscriptProof?.result;
      if (result === undefined || result === null) throw new Error("missing_result");
      for (const invalid of [
        { ...result, reason: "unsupported_reason" },
        { ...result, transcriptCompleteness: "pending" },
        { ...result, liveAt: undefined },
        { ...result, endedAt: "200" },
        { ...result, endedAt: 99 },
        { ...result, warnings: [] },
        {
          ...result,
          transcriptCompleteness: "complete",
          transcriptIncompleteReasons: [{ kind: "final_input_unresolved" }],
        },
        {
          ...result,
          transcriptCompleteness: "incomplete",
          transcriptIncompleteReasons: [],
        },
        {
          ...result,
          transcriptIncompleteReasons: [
            { kind: "eligible_transcript_item_pending", itemId: 42, role: "participant" },
          ],
        },
        { ...result, transcriptIncompleteReasons: [{ kind: "unknown_reason" }] },
        { ...result, transcriptSnapshot: { ...result.transcriptSnapshot, unknown: true } },
        { ...result, transcriptSnapshot: { ...result.transcriptSnapshot, turnCount: "1" } },
        Object.create(result),
      ])
        expect(parseCompletedResult(invalid)).toBeNull();
      const mutable = { ...result, transcriptSnapshot: { ...result.transcriptSnapshot } };
      const parsed = parseCompletedResult(mutable);
      expect(parsed).toEqual(result);
      mutable.transcriptSnapshot.turnCount = 99;
      expect(parsed?.transcriptSnapshot.turnCount).toBe(1);
      const inherited: unknown = Object.assign(Object.create({ warnings: ["private"] }), result);
      expect(parseCompletedResult(inherited)).toEqual(result);
      const copied = decodeInterviewFinalizationAggregate(ended);
      expect(copied).toEqual(ended);
      expect(copied).not.toBe(ended);
      expect(copied?.applicationTranscriptProof).not.toBe(ended.applicationTranscriptProof);
      expect(() => decodeInterviewFinalizationAggregate(Object.create(ended))).toThrow();
      const proof = ended.applicationTranscriptProof;
      for (const change of [
        { completedReason: "agent_requested_end" },
        { interrupted: true },
        {
          result: {
            ...result,
            reason: reason === "participant_stopped" ? "timebox_reached" : "participant_stopped",
          },
        },
        { result: { ...result, transcriptCompleteness: "incomplete" } },
        {
          result: {
            ...result,
            transcriptIncompleteReasons: [{ kind: "final_input_unresolved" }],
          },
        },
        { result: { ...result, transcriptIncompleteReasons: undefined } },
      ]) {
        expect(
          decodeInterviewFinalizationAggregate(
            JSON.stringify({ ...ended, applicationTranscriptProof: { ...proof, ...change } }),
          ),
        ).toBeNull();
      }
    });
  },
);
