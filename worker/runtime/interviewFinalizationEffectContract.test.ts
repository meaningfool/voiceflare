import { Effect } from "effect";
import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { advanceInterviewFinalization } from "./interviewFinalizationFSM.ts";
import {
  finalizationEffectKinds,
  type FinalizationEffectKind,
  type FinalizationEffectRecord,
  type FinalizationEffectOutcome,
  type FinalizationDecision,
  type InterviewFinalizationAggregate,
} from "./interviewFinalizationModel.ts";
import { runInterviewFinalizationEffect } from "./interviewFinalizationEffectRunner.ts";
import { computeRuntimeTranscriptDigest } from "../shared/runtimeTranscriptSnapshot.ts";
import type { FinalizationEffectStagePolicy } from "./interviewFinalizationEffectPolicy.ts";
import { decodeInterviewFinalizationAggregate } from "./interviewFinalizationPersistenceDecoder.ts";
import { projectInterviewFinalizationExecution } from "./interviewFinalizationWorkProjection.ts";

function project(aggregate: InterviewFinalizationAggregate) {
  return projectInterviewFinalizationExecution(aggregate, {
    now: 100,
    liveDeadlineAt: null,
    participantPresenceDeadlineAt: null,
  });
}

function settle(aggregate: InterviewFinalizationAggregate, at: number) {
  return aggregate.state.effects
    .filter((effect) => effect.status === "pending")
    .reduce(
      (current, effect) =>
        advanceInterviewFinalization(current, {
          kind: "effect_outcome",
          effectId: effect.id,
          outcome: { status: "dispatched" },
          at,
        }).aggregate,
      aggregate,
    );
}

function stages() {
  const live = liveFinalizationAggregate({ runId: "effect-contract" });
  const draining = advanceInterviewFinalization(live, {
    kind: "end_requested",
    reason: "participant_stopped",
    source: "browser_request",
    at: 100,
  }).aggregate;
  // Provider cleanup begins at the checkpoint while the final item's text is still owed.
  const admitted = advanceInterviewFinalization(settle(draining, 101), {
    kind: "participant_answer_created",
    itemId: "effect-contract-final-item",
    generation: 1,
    sequence: 1,
  }).aggregate;
  const closing_provider = advanceInterviewFinalization(admitted, {
    kind: "deadline_reached",
    deadline: "drain",
    at: 9100,
  }).aggregate;
  const finalizing = advanceInterviewFinalization(settle(closing_provider, 9101), {
    kind: "deadline_reached",
    deadline: "finalization_cutoff",
    at: 20000,
  }).aggregate;
  const ended = advanceInterviewFinalization(finalizing, {
    kind: "transcript_digest_computed",
    revision: finalizing.transcriptRevision,
    digest: `sha256:${"a".repeat(64)}`,
    at: 20001,
  }).aggregate;
  return { live, draining, closing_provider, finalizing, ended };
}

function effect(kind: FinalizationEffectKind): FinalizationEffectRecord {
  const fields = {
    id: `fixture-${kind}`,
    status: "pending",
    acceptance: "unobserved",
    attemptCount: 0,
  } as const;
  if (kind === "cancel_reply") return { ...fields, kind, responseId: "response-fixture" };
  if (kind === "compute_transcript_digest") return { ...fields, kind, revision: 0 };
  if (kind === "close_input") return { ...fields, kind, heldItemId: null };
  return { ...fields, kind };
}

function withEffect(
  aggregate: InterviewFinalizationAggregate,
  candidate: FinalizationEffectRecord,
): InterviewFinalizationAggregate {
  const existing = aggregate.state.effects.find((record) => record.kind === candidate.kind);
  const replacement = {
    ...candidate,
    id: existing?.id ?? `${aggregate.runId}:${aggregate.nextEffectSequence}`,
  };
  return {
    ...aggregate,
    nextEffectSequence: aggregate.nextEffectSequence + 1,
    state: {
      ...aggregate.state,
      effects: [
        ...aggregate.state.effects.filter((record) => record.kind !== candidate.kind),
        replacement,
      ],
    },
  };
}

describe("durable effect contract baseline", () => {
  it("constructs accepted aggregates in all five stages through the FSM", () => {
    for (const [stage, aggregate] of Object.entries(stages())) {
      expect(aggregate.state.stage).toBe(stage);
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
    }
  });

  it.each(["live", "finalizing"] as const)(
    "preserves the %s pending alarm persistence/execution discrepancy",
    (stage) => {
      const aggregate = withEffect(stages()[stage], effect("arm_alarm"));
      expect(project(aggregate).effects.map(({ effect }) => effect.kind)).toContain("arm_alarm");
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(aggregate))).toBeNull();
      const settled = withEffect(aggregate, { ...effect("arm_alarm"), status: "dispatched" });
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(settled))).toEqual(settled);
      expect(project(settled).effects.map(({ effect }) => effect.kind)).not.toContain("arm_alarm");
    },
  );

  it("retains a pending input closure in closing storage without running it", () => {
    const aggregate = withEffect(stages().closing_provider, effect("close_input"));
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
    expect(project(aggregate).effects.map(({ effect }) => effect.kind)).not.toContain(
      "close_input",
    );
  });

  it.each(["sending", "failed", "uncertain", "dispatched"] as const)(
    "retains %s history without projecting it as pending work",
    (status) => {
      for (const kind of finalizationEffectKinds) {
        const aggregate = withEffect(stages().live, { ...effect(kind), status });
        expect(decodeInterviewFinalizationAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
        expect(project(aggregate).effects).toEqual([]);
      }
    },
  );

  it("retains and executes only the never-started terminal hangup", () => {
    for (const kind of finalizationEffectKinds) {
      const aggregate = withEffect(stages().ended, effect(kind));
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(aggregate))).toEqual(
        kind === "release_session" ? aggregate : null,
      );
      expect(project(aggregate).effects.map(({ effect: selected }) => selected.kind)).toEqual(
        kind === "release_session" ? ["release_session"] : [],
      );
    }
  });
});

describe("effect policy compile-time completeness", () => {
  it("requires each stage and every kind in each stage", () => {
    expectTypeOf<
      Omit<FinalizationEffectStagePolicy, "ended">
    >().not.toExtend<FinalizationEffectStagePolicy>();
    expectTypeOf<Omit<FinalizationEffectStagePolicy["live"], "arm_alarm">>().not.toExtend<
      FinalizationEffectStagePolicy["live"]
    >();
  });
});

describe("persisted effect consumer contract", () => {
  it("rejects missing or wrongly typed effect fields before work reaches the runner", () => {
    const aggregate = withEffect(stages().live, {
      ...effect("cancel_reply"),
      status: "dispatched",
    });
    const valid = aggregate.state.effects[0];
    if (valid?.kind !== "cancel_reply") throw new Error("Missing stored cancellation");
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
    const { id: _id, ...missingId } = valid;
    const { kind: _kind, ...missingKind } = valid;
    const { status: _status, ...missingStatus } = valid;
    const { acceptance: _acceptance, ...missingAcceptance } = valid;
    const { attemptCount: _attemptCount, ...missingAttemptCount } = valid;
    const { responseId: _responseId, ...missingResponseId } = valid;
    for (const [name, record] of Object.entries({
      missingId,
      missingKind,
      missingStatus,
      missingAcceptance,
      missingAttemptCount,
      missingResponseId,
      wrongId: { ...valid, id: 42 },
      wrongKind: { ...valid, kind: 42 },
      unknownKind: { ...valid, kind: "unknown_effect" },
      wrongStatus: { ...valid, status: 42 },
      wrongAcceptance: { ...valid, acceptance: 42 },
      wrongAttemptCount: { ...valid, attemptCount: "0" },
      wrongResponseId: { ...valid, responseId: 42 },
      extraField: { ...valid, unexpected: true },
    })) {
      const raw = { ...aggregate, state: { ...aggregate.state, effects: [record] } };
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(raw)), name).toBeNull();
    }
    const digest = withEffect(stages().live, {
      ...effect("compute_transcript_digest"),
      status: "dispatched",
    });
    const validDigest = digest.state.effects[0];
    if (validDigest?.kind !== "compute_transcript_digest")
      throw new Error("Missing stored digest effect");
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(digest))).toEqual(digest);
    const { revision: _revision, ...missingRevision } = validDigest;
    for (const record of [missingRevision, { ...validDigest, revision: "0" }]) {
      const raw = { ...digest, state: { ...digest.state, effects: [record] } };
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(raw))).toBeNull();
    }
  });

  it("rejects malformed aggregate and nested consumer values even when they are valid JSON", () => {
    const aggregate = stages().draining;
    const ended = stages().ended;
    if (ended.state.stage !== "ended") throw new Error("Expected ended aggregate.");
    const { runId: _runId, ...missingRunId } = aggregate;
    const { stage: _stage, ...missingStage } = aggregate.state;
    const { effects: _effects, ...missingEffects } = aggregate.state;
    for (const [name, raw] of Object.entries({
      missingRunId,
      wrongRunId: { ...aggregate, runId: 42 },
      missingStage: { ...aggregate, state: missingStage },
      wrongStage: { ...aggregate, state: { ...aggregate.state, stage: 42 } },
      missingEffects: { ...aggregate, state: missingEffects },
      wrongEffects: { ...aggregate, state: { ...aggregate.state, effects: {} } },
      wrongPublication: {
        ...ended,
        state: {
          ...ended.state,
          publication: { ...ended.state.publication, transcriptDelivered: "false" },
        },
      },
      wrongPublicationCutoff: {
        ...ended,
        state: {
          ...ended.state,
          publication: { ...ended.state.publication, publicationCutoffAt: "later" },
        },
      },
      wrongFinalInputFence: {
        ...aggregate,
        finalInput: { ...aggregate.finalInput, fence: { generation: "0", sequence: 0 } },
      },
      wrongTranscriptItem: {
        ...aggregate,
        transcriptCapture: {
          sequence: 1,
          items: [{ itemId: "item-1", firstSeenSequence: 0, text: 42 }],
        },
      },
    })) {
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(raw)), name).toBeNull();
    }
  });

  it("validates the persisted publication cutoff against the frozen result", () => {
    const ended = stages().ended;
    if (ended.state.stage !== "ended") throw new Error("Expected ended aggregate.");
    const publication = ended.state.publication;
    const cutoffAt = ended.state.completion.finalizedAt + 30_000;
    expect(publication.publicationCutoffAt).toBe(cutoffAt);
    const { publicationCutoffAt: _cutoff, ...withoutCutoff } = publication;
    for (const [name, raw] of Object.entries({
      laterCutoff: {
        ...ended,
        state: {
          ...ended.state,
          publication: { ...publication, publicationCutoffAt: cutoffAt + 1 },
        },
      },
      expiredWithoutCutoff: {
        ...ended,
        state: {
          ...ended.state,
          publication: { ...withoutCutoff, status: "expired", retryAt: null },
        },
      },
      missingCutoff: { ...ended, state: { ...ended.state, publication: withoutCutoff } },
      // Publication belongs to the frozen result only.
      publicationBeforeFreeze: { ...stages().finalizing, publication },
    }))
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(raw)), name).toBeNull();
  });
});

function emissionDecisions(): readonly FinalizationDecision[] {
  const active = advanceInterviewFinalization(stages().live, {
    kind: "reply_started",
    responseId: "active-response",
    generation: 1,
    sequence: 1,
  });
  const draining = advanceInterviewFinalization(active.aggregate, {
    kind: "end_requested",
    reason: "participant_stopped",
    source: "browser_request",
    at: 100,
  });
  const closing = advanceInterviewFinalization(settle(draining.aggregate, 101), {
    kind: "deadline_reached",
    deadline: "drain",
    at: 9100,
  });
  const finalizing = advanceInterviewFinalization(settle(closing.aggregate, 9101), {
    kind: "deadline_reached",
    deadline: "finalization_cutoff",
    at: 20000,
  });
  return [active, draining, closing, finalizing];
}

function reconstruct(aggregate: InterviewFinalizationAggregate): InterviewFinalizationAggregate {
  const decoded = decodeInterviewFinalizationAggregate(JSON.stringify(aggregate));
  expect(decoded).toEqual(aggregate);
  if (decoded === null) throw new Error("Expected a valid stored aggregate");
  return decoded;
}

describe("vertical durable effect behavior", () => {
  it.each(finalizationEffectKinds)("emits, stores, projects, runs and applies %s", async (kind) => {
    const emission = emissionDecisions().find((decision) =>
      decision.effects.some((effect) => effect.kind === kind),
    );
    expect(emission, `owning transition for ${kind}`).toBeDefined();
    if (emission === undefined) throw new Error("Missing effect emission");
    const aggregate = reconstruct(emission.aggregate);
    const selected = project(aggregate).effects.find(({ effect }) => effect.kind === kind);
    if (selected === undefined) throw new Error(`Missing projected work: ${kind}`);
    expect(emission.effects).toContainEqual(selected.effect);
    const calls: string[] = [];
    const result = await runSelectedEffect({
      effect: selected.effect,
      capabilities: {
        repository: {
          recordAttempt: (id) => {
            calls.push(`attempt:${id}`);
          },
        },
        connection: { ready: true },
        provider: {
          sendFinalizationOperation: (command) => {
            calls.push(command.kind);
            return { status: "dispatched" };
          },
          release: () => {
            calls.push("hangup");
            return Effect.succeed({ status: "dispatched" as const });
          },
        },
      },
    });
    const commands = {
      compute_transcript_digest: [],
      close_input: ["close_input"],
      discard_later_input: ["discard_later_input"],
      cancel_reply: ["cancel_reply"],
      stop_output: ["stop_output"],
      release_session: ["hangup"],
      arm_alarm: [],
    } satisfies Record<FinalizationEffectKind, readonly string[]>;
    expect(calls).toEqual([`attempt:${selected.effect.id}`, ...commands[kind]]);
    expect(result.outcome).toEqual({ status: "dispatched" });
    const observed = advanceInterviewFinalization(aggregate, {
      kind: "effect_outcome",
      effectId: result.effectId,
      outcome: result.outcome,
      at: 20001,
    }).aggregate;
    if (kind === "compute_transcript_digest") {
      const digest = await computeRuntimeTranscriptDigest({ turns: [] });
      const ended = advanceInterviewFinalization(observed, {
        kind: "transcript_digest_computed",
        revision: result.digestRevision ?? -1,
        digest,
        at: 20002,
      }).aggregate;
      expect(ended.state.stage).toBe("ended");
      expect(ended.state.effects.find((effect) => effect.id === result.effectId)?.status).toBe(
        "dispatched",
      );
      expect(reconstruct(ended).transcriptDigest).toBe(digest);
      expect(project(ended).effects).toEqual([]);
    } else {
      expect(observed.state.effects.find((effect) => effect.id === result.effectId)?.status).toBe(
        "dispatched",
      );
      expect(project(observed).effects.map(({ effect }) => effect.id)).not.toContain(
        result.effectId,
      );
      reconstruct(observed);
    }
  });

  it.each([
    { provider: { status: "dispatched" }, expected: { status: "dispatched" } },
    {
      provider: { status: "benign_rejection", code: "nothing_to_settle" },
      expected: { status: "benign_rejection", code: "nothing_to_settle" },
    },
    {
      provider: { status: "failed", code: "provider_send_failed" },
      expected: { status: "uncertain", code: "provider_send_failed" },
    },
    {
      provider: { status: "uncertain", code: "sideband_unavailable" },
      expected: { status: "failed", code: "session_unavailable_before_dispatch" },
    },
  ] as const satisfies readonly Readonly<{
    provider: FinalizationEffectOutcome;
    expected: FinalizationEffectOutcome;
  }>[])(
    "preserves final-input at-most-once outcome through storage and feedback",
    async ({ provider, expected }) => {
      const aggregate = reconstruct(stages().draining);
      const selected = project(aggregate).effects.find(
        ({ effect }) => effect.kind === "close_input",
      );
      if (selected === undefined) throw new Error("Missing final-input work");
      const sendFinalizationOperation = vi.fn(() => provider);
      const result = await runSelectedEffect({
        effect: selected.effect,
        capabilities: {
          repository: { recordAttempt: vi.fn() },
          connection: { ready: provider.status !== "uncertain" },
          provider: { sendFinalizationOperation, release: vi.fn() },
        },
      });
      expect(result.outcome).toEqual(expected);
      expect(sendFinalizationOperation).toHaveBeenCalledTimes(
        provider.status === "uncertain" ? 0 : 1,
      );
      const observed = reconstruct(
        advanceInterviewFinalization(aggregate, {
          kind: "effect_outcome",
          effectId: result.effectId,
          outcome: result.outcome,
          at: 101,
        }).aggregate,
      );
      expect(observed.state.effects.find((effect) => effect.id === result.effectId)).toMatchObject({
        status: expected.status === "benign_rejection" ? "dispatched" : expected.status,
      });
      expect(project(observed).effects.map(({ effect }) => effect.id)).not.toContain(
        result.effectId,
      );
      const closing = advanceInterviewFinalization(observed, {
        kind: "deadline_reached",
        deadline: "drain",
        at: 9100,
      }).aggregate;
      expect(project(closing).effects.map(({ effect }) => effect.kind)).not.toContain(
        "close_input",
      );
    },
  );

  it("does not dispatch pre-empted final input or terminal retained work", async () => {
    const sendFinalizationOperation = vi.fn(() => ({ status: "dispatched" as const }));
    const release = vi.fn(() => Effect.succeed({ status: "dispatched" as const }));
    for (const aggregate of [
      withEffect(stages().closing_provider, effect("close_input")),
      stages().ended,
    ]) {
      const forbidden = project(reconstruct(aggregate)).effects.filter(
        ({ effect }) => effect.kind === "close_input",
      );
      for (const selected of forbidden)
        await runSelectedEffect({
          effect: selected.effect,
          capabilities: {
            repository: { recordAttempt: vi.fn() },
            connection: { ready: true },
            provider: { sendFinalizationOperation, release },
          },
        });
      expect(forbidden).toEqual([]);
    }
    expect(sendFinalizationOperation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});

function runSelectedEffect(input: Parameters<typeof runInterviewFinalizationEffect>[0]) {
  return Effect.runPromise(Effect.suspend(() => runInterviewFinalizationEffect(input)));
}
