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

async function seal(
  aggregate: InterviewFinalizationAggregate,
  afterBound?: (aggregate: InterviewFinalizationAggregate) => InterviewFinalizationAggregate,
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
    at: cutoff + 1,
  });
  expect(next.state.stage).toBe("ended");
  return next;
}

function finish(aggregate: InterviewFinalizationAggregate, sequence = 3) {
  return step(aggregate, {
    kind: "provider_finish_interview_observed",
    responseId: "closing",
    callId: "finish-call",
    at: 200,
    generation: 1,
    sequence,
  });
}
function inventory(
  aggregate: InterviewFinalizationAggregate,
  sequence = 4,
  itemIds = ["first", "second"],
) {
  return step(aggregate, {
    kind: "reply_generated",
    responseId: "closing",
    status: "completed",
    transcriptInventoryComplete: true,
    transcriptItems: itemIds.map((itemId, outputIndex) => ({
      itemId,
      role: "conversationAgent",
      responseId: "closing",
      outputIndex,
    })),
    generation: 1,
    sequence,
  });
}
function closingText(aggregate: InterviewFinalizationAggregate, itemId: string, sequence: number) {
  return step(aggregate, {
    kind: "agent_transcript_finalized",
    responseId: "closing",
    itemId,
    text: `Closing ${itemId}`,
    generation: 1,
    sequence,
    providerEventId: `text-${itemId}`,
  });
}

describe("Application agent completion Transcript certification", () => {
  it.each(["finish-first", "inventory-first", "text-first"])(
    "seals all winning-response items with %s",
    async (order) => {
      let aggregate = text(input(live()));
      if (order === "finish-first") aggregate = inventory(finish(aggregate));
      if (order === "inventory-first") aggregate = finish(inventory(aggregate, 3), 4);
      if (order === "text-first")
        aggregate = inventory(finish(closingText(aggregate, "first", 3), 4), 5);
      aggregate = closingText(aggregate, "first", 6);
      const duplicate = closingText(aggregate, "first", 6);
      expect(duplicate).toEqual(aggregate);
      aggregate = closingText(duplicate, "second", 8);
      const ended = await seal(aggregate);
      expect(ended.applicationTranscriptProof?.result).toMatchObject({
        outcome: "completed",
        reason: "agent_requested_end",
        liveAt: 100,
        endedAt: 200,
        transcriptCompleteness: "complete",
        transcriptSnapshot: { turnCount: 3 },
      });
      expect(readFinalizationTranscriptTurns(ended)).toEqual([
        { role: "participant", text: "My feedback" },
        { role: "conversationAgent", text: "Closing first" },
        { role: "conversationAgent", text: "Closing second" },
      ]);
      expect(closingText(ended, "new-item", 50)).toEqual(ended);
    },
  );

  it("requires every item's final text despite terminal response and settled audio", async () => {
    let aggregate = closingText(inventory(finish(text(input(live())))), "first", 5);
    aggregate = step(aggregate, {
      kind: "reply_delivery_stopped",
      responseId: "closing",
      generation: 1,
      sequence: 6,
    });
    aggregate = step(aggregate, { kind: "deadline_reached", deadline: "drain", at: 1_201 });
    expect(aggregate.state.stage).toBe("draining");
    const restored = decodeInterviewFinalizationAggregate(JSON.stringify(aggregate));
    if (restored === null) throw new Error("missing_restored_proof");
    const ended = await seal(restored);
    expect(ended.applicationTranscriptProof?.result).toMatchObject({
      outcome: "completed",
      reason: "agent_requested_end",
      endedAt: 200,
      transcriptCompleteness: "incomplete",
    });
    expect(closingText(ended, "second", 70)).toEqual(ended);
  });

  it.each([false, true])(
    "requires conclusive no-Transcript response inventory: %s",
    async (conclusive) => {
      let aggregate = finish(text(input(live())));
      aggregate = step(aggregate, {
        kind: "reply_generated",
        responseId: "closing",
        status: "completed",
        transcriptItems: [],
        transcriptInventoryComplete: conclusive,
        generation: 1,
        sequence: 4,
      });
      const ended = await seal(aggregate);
      expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe(
        conclusive ? "complete" : "incomplete",
      );
      expect(ended.applicationTranscriptProof?.result?.transcriptIncompleteReasons).toEqual(
        conclusive
          ? []
          : [
              { kind: "conversation_evidence_gap" },
              {
                kind: "closing_response_inventory_unresolved",
                responseId: "closing",
              },
            ],
      );
    },
  );

  it.each([false, true])(
    "preserves the agent winner after stop and failure; proof settled=%s",
    async (settled) => {
      let aggregate = inventory(finish(text(input(live()))), 4, ["first"]);
      if (settled) aggregate = closingText(aggregate, "first", 5);
      aggregate = step(aggregate, {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 300,
      });
      aggregate = step(aggregate, { kind: "runtime_failure_observed", source: "runtime", at: 400 });
      aggregate = closingText(aggregate, "first", 6);
      const ended = await seal(aggregate);
      expect(ended.applicationTranscriptProof?.result).toMatchObject({
        outcome: "completed",
        reason: "agent_requested_end",
        endedAt: 200,
        // Without a loss of the execution's session, the closing's late text still counts.
        transcriptCompleteness: "complete",
      });
    },
  );

  it("excludes unrelated response output and final text after the bound", async () => {
    let aggregate = inventory(finish(text(input(live()))), 4, ["first"]);
    aggregate = step(aggregate, {
      kind: "agent_transcript_finalized",
      responseId: "unrelated",
      itemId: "outside",
      text: "Not eligible",
      generation: 1,
      sequence: 5,
    });
    const ended = await seal(aggregate, (bounded) => closingText(bounded, "first", 6));
    expect(readFinalizationTranscriptTurns(ended)).toEqual([
      { role: "participant", text: "My feedback" },
    ]);
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("incomplete");
  });

  it.each(["participant_stopped", "timebox_reached", "runtime_failed"] as const)(
    "preserves earlier %s",
    async (reason) => {
      const stopped = step(text(input(live())), {
        kind: "end_requested",
        reason,
        source: "runtime",
        at: 150,
      });
      const ended = await seal(finish(stopped));
      expect(ended.applicationTranscriptProof?.result).toMatchObject({
        endedAt: 150,
        outcome: reason === "runtime_failed" ? "interrupted" : "completed",
      });
      if (ended.applicationTranscriptProof?.result?.outcome === "completed")
        expect(ended.applicationTranscriptProof.result.reason).toBe(reason);
    },
  );

  it("keeps existing eligible obligations when a winning response has no Transcript output", async () => {
    const aggregate = inventory(finish(input(live()), 2), 3, []);
    const ended = await seal(aggregate);
    expect(ended.applicationTranscriptProof?.result?.transcriptCompleteness).toBe("incomplete");
  });

  it("accepts late final evidence for another item already eligible at the end fence", async () => {
    let aggregate = step(text(input(live())), {
      kind: "transcript_item_observed",
      itemId: "earlier",
      role: "conversationAgent",
      responseId: "earlier-response",
      generation: 1,
      sequence: 3,
    });
    aggregate = inventory(finish(aggregate, 4), 5, []);
    aggregate = step(aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "earlier",
      responseId: "earlier-response",
      text: "Earlier eligible text",
      generation: 1,
      sequence: 6,
    });
    expect((await seal(aggregate)).applicationTranscriptProof?.result?.transcriptCompleteness).toBe(
      "complete",
    );
  });

  it("retains known failed final text despite a subsequent successful-looking duplicate", async () => {
    let aggregate = inventory(finish(text(input(live()))), 4, ["first"]);
    aggregate = step(aggregate, {
      kind: "agent_transcript_finalized",
      itemId: "first",
      responseId: "closing",
      generation: 1,
      sequence: 5,
    });
    aggregate = closingText(aggregate, "first", 6);
    expect((await seal(aggregate)).applicationTranscriptProof?.result?.transcriptCompleteness).toBe(
      "incomplete",
    );
  });

  it("uses cancelled response inventory for the Transcript proof", async () => {
    const observation = {
      kind: "reply_cancelled",
      responseId: "closing",
      generation: 1,
      sequence: 4,
      transcriptInventoryComplete: true,
      transcriptItems: [
        { itemId: "first", role: "conversationAgent", responseId: "closing", outputIndex: 0 },
      ],
    } as const;
    const application = step(finish(text(input(live()))), observation);
    expect(application.applicationTranscriptProof?.inventoriedResponseIds).toContain("closing");
    expect(
      (await seal(application)).applicationTranscriptProof?.result?.transcriptCompleteness,
    ).toBe("incomplete");
  });

  it("rejects corrupted inventory proof at the persisted production ingress", async () => {
    const ended = await seal(inventory(finish(text(input(live()))), 4, []));
    const proof = ended.applicationTranscriptProof;
    for (const change of [
      { inventoriedResponseIds: ["closing", "closing"] },
      { inventoriedResponseIds: [4] },
      { inventoriedResponseIds: [] },
      { inventoriedResponseIds: undefined },
      { unknown: true },
      {
        obligations: [
          { itemId: "participant", role: "participant", status: "captured", unknown: true },
        ],
      },
    ]) {
      expect(
        decodeInterviewFinalizationAggregate(
          JSON.stringify({ ...ended, applicationTranscriptProof: { ...proof, ...change } }),
        ),
      ).toBeNull();
    }
    const mutable = {
      ...ended,
      applicationTranscriptProof: { ...proof, inventoriedResponseIds: ["closing"] },
    };
    const copied = decodeInterviewFinalizationAggregate(mutable);
    mutable.applicationTranscriptProof.inventoriedResponseIds.push("changed");
    expect(copied?.applicationTranscriptProof?.inventoriedResponseIds).toEqual(["closing"]);
  });
});
