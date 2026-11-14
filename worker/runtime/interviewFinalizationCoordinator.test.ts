import { Effect, Exit } from "effect";
import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { advanceInterviewFinalization } from "./interviewFinalizationFSM.ts";
import { normalizeProviderRuntimeObservation } from "../providers/openaiRealtime/providerEvents.ts";
import { runtimeReport } from "../providers/openaiRealtime/speech.ts";
import {
  readFinalizationTranscriptTurns,
  type InterviewFinalizationAggregate,
  type ConversationReceiptPrefix,
} from "./interviewFinalizationModel.ts";
import {
  InterviewFinalizationCoordinator,
  type InterviewFinalizationCoordinatorProvider,
  type InterviewFinalizationCoordinatorPublication,
} from "./interviewFinalizationCoordinator.ts";
import { InterviewFinalizationRepository } from "./interviewFinalizationRepository.ts";
import type { EndingOperation, SessionReleaseAnswer } from "./nativeContracts.ts";
import {
  REALTIME_MODEL,
  selectInterviewModels,
} from "../providers/openaiRealtime/preparedModelSession.ts";
import { createRuntimeUsageAccounting } from "./runtimeUsage.ts";
import {
  createDurableObjectState,
  createTestDurableObjectContext,
} from "./testing/interviewRuntimeControllerTestHarness.ts";

const openDatabases: Array<ReturnType<typeof createTestDurableObjectContext>> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const durable of openDatabases.splice(0)) durable.close();
});

describe("InterviewFinalizationCoordinator", () => {
  it("resamples a required receipt arriving during deadline preflight before freezing", async () => {
    const at = 1_700_000_002_000;
    let prefix: ConversationReceiptPrefix = { receivedOrder: null, processedThroughOrder: null };
    const harness = setupCoordinator({
      now: at,
      provider: provider({ sampleReceiptPrefix: () => prefix }),
    });
    const live = harness.repository.readAggregate();
    if (live.state.stage !== "live") throw new Error("Expected live setup");
    const seeded = {
      ...live,
      runtimeUsage: createRuntimeUsageAccounting(),
      state: { ...live.state, activeInputItemId: "final" },
      applicationTranscriptProof: {
        liveAt: at - 1000,
        interrupted: false,
        obligations: [
          { itemId: "final", role: "participant" as const, status: "pending" as const },
        ],
        closeBarrier: null,
        result: null,
      },
    };
    const ending = advanceInterviewFinalization(seeded, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at,
    }).aggregate;
    harness.repository.persistAggregate(ending, null);
    const handoff = Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "participant_answer_transcribed",
          itemId: "final",
          text: "The final feedback",
          generation: 1,
          sequence: 1,
          observedAt: at + 1,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );
    // acceptObservation yields at the deadline preflight; the native FIFO receives
    // another receipt before the synchronous evidence decision and commit.
    prefix = {
      receivedOrder: { generation: 1, sequence: 2 },
      processedThroughOrder: { generation: 1, sequence: 1 },
    };
    await handoff;
    expect(harness.repository.readAggregate().state.stage).toBe("draining");
    expect(readFinalizationTranscriptTurns(harness.repository.readAggregate())).toEqual([
      { role: "participant", text: "The final feedback" },
    ]);
    prefix = { ...prefix, processedThroughOrder: { generation: 1, sequence: 2 } };
    await Effect.runPromise(harness.coordinator.reconsiderEvidence(at + 2));
    expect(harness.repository.readAggregate().state.stage).toBe("finalizing");
  });

  it("accounts admitted response usage during finalizing once before sealing", async () => {
    let now = 1_700_000_002_000;
    const harness = setupCoordinator({ now: () => now });
    harness.repository.persistAggregate(
      {
        ...harness.repository.readAggregate(),
        runtimeUsage: createRuntimeUsageAccounting(),
        applicationTranscriptProof: {
          liveAt: now - 1_000,
          interrupted: false,
          obligations: [],
          closeBarrier: null,
          result: null,
        },
      },
      null,
    );
    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        { kind: "reply_started", responseId: "admitted", generation: 1, sequence: 1 },
        undefined,
        { deferEffectExecution: true },
      ),
    );
    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: now,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );
    now += 10_000;
    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        { kind: "deadline_reached", deadline: "finalization_cutoff", at: now },
        undefined,
        { deferEffectExecution: true },
      ),
    );
    expect(harness.repository.readAggregate().state.stage).toBe("finalizing");
    const receipt = JSON.stringify({
      event_id: "admitted-usage",
      type: "response.done",
      response: {
        id: "admitted",
        status: "completed",
        output: [],
        usage: {
          total_tokens: 7,
          input_tokens: 5,
          output_tokens: 2,
          input_token_details: {
            text_tokens: 5,
            audio_tokens: 0,
            image_tokens: 0,
            cached_tokens: 0,
            cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
          },
          output_token_details: { text_tokens: 2, audio_tokens: 0 },
        },
      },
    });
    for (const sequence of [2, 3]) {
      const observation = normalizeProviderRuntimeObservation(
        receipt,
        sequence,
        true,
        now + 1,
        selectInterviewModels(),
      );
      if (observation === null) throw new Error("Expected terminal usage receipt");
      await Effect.runPromise(
        harness.coordinator.acceptObservation(
          runtimeReport(observation),
          {
            sessionId: "call",
            sequence,
            providerEventId: "admitted-usage",
            diagnosticSummary: {},
          },
          { deferEffectExecution: true },
        ),
      );
    }
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    const frozen = harness.repository.readAggregate();
    expect(frozen.state.stage).toBe("ended");
    expect(frozen.applicationTranscriptProof?.result?.runtimeUsage).toEqual({
      completeness: "complete",
      observations: [
        {
          componentRole: "speech_to_speech",
          provider: "openai",
          model: REALTIME_MODEL,
          measure: "output_text",
          unit: "token",
          quantity: 2,
        },
        {
          componentRole: "speech_to_speech",
          provider: "openai",
          model: REALTIME_MODEL,
          measure: "uncached_input_text",
          unit: "token",
          quantity: 5,
        },
      ],
    });
    const late = normalizeProviderRuntimeObservation(
      receipt,
      4,
      true,
      now + 2,
      selectInterviewModels(),
    );
    if (late === null) throw new Error("Expected late usage receipt");
    await Effect.runPromise(
      harness.coordinator.acceptObservation(runtimeReport(late), undefined, {
        deferEffectExecution: true,
      }),
    );
    expect(harness.repository.readAggregate()).toEqual(frozen);
  });

  it("reports only persisted canonical text revisions and preserves end acceptance", async () => {
    const harness = setupCoordinator({ now: 1_700_000_002_000 });
    const text = {
      kind: "agent_transcript_finalized",
      itemId: "assistant_text",
      responseId: "assistant_response",
      text: "  Exact final text\n",
      generation: 1,
      sequence: 1,
    } as const;
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation(text, undefined, { deferEffectExecution: true }),
      ),
    ).resolves.toEqual({ accepted: false, transcriptChanged: true });
    expect(readFinalizationTranscriptTurns(harness.repository.readAggregate())).toEqual([
      { role: "conversationAgent", text: "  Exact final text\n" },
    ]);
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation({ ...text, sequence: 2 }, undefined, {
          deferEffectExecution: true,
        }),
      ),
    ).resolves.toEqual({ accepted: false, transcriptChanged: false });
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "end_requested",
            reason: "participant_stopped",
            source: "browser_request",
            at: 1_700_000_002_000,
          },
          undefined,
          { deferEffectExecution: true },
        ),
      ),
    ).resolves.toEqual({ accepted: true, transcriptChanged: false });
  });

  it("signals visible ordering revisions but excludes unchanged metadata and duplicate identities", async () => {
    const harness = setupCoordinator({ now: 1_700_000_002_000 });
    for (const [sequence, itemId, text] of [
      [1, "a", "A"],
      [2, "b", "B"],
    ] as const) {
      await Effect.runPromise(
        harness.coordinator.acceptObservation(
          { kind: "participant_answer_transcribed", itemId, text, generation: 1, sequence },
          undefined,
          { deferEffectExecution: true },
        ),
      );
    }
    const metadata = {
      kind: "transcript_item_observed",
      itemId: "a",
      previousItemId: "b",
      role: "participant",
      generation: 1,
      sequence: 3,
    } as const;
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation(
          metadata,
          { sessionId: "call", sequence: 3, providerEventId: "order", diagnosticSummary: {} },
          { deferEffectExecution: true },
        ),
      ),
    ).resolves.toEqual({ accepted: false, transcriptChanged: true });
    expect(readFinalizationTranscriptTurns(harness.repository.readAggregate())).toEqual([
      { role: "participant", text: "B" },
      { role: "participant", text: "A" },
    ]);
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation({ ...metadata, sequence: 4 }, undefined, {
          deferEffectExecution: true,
        }),
      ),
    ).resolves.toEqual({ accepted: false, transcriptChanged: false });
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "participant_answer_transcribed",
            itemId: "a",
            text: "Duplicate replacement",
            generation: 1,
            sequence: 5,
          },
          { sessionId: "call", sequence: 5, providerEventId: "order", diagnosticSummary: {} },
          { deferEffectExecution: true },
        ),
      ),
    ).resolves.toEqual({ accepted: false, transcriptChanged: false });
    expect(readFinalizationTranscriptTurns(harness.repository.readAggregate())).toEqual([
      { role: "participant", text: "B" },
      { role: "participant", text: "A" },
    ]);
  });

  it("keeps rejected late text from signaling or rewriting a frozen Transcript", async () => {
    const harness = setupCoordinator({ now: 1_700_000_002_000 });
    harness.repository.persistAggregate(endedAggregate(harness.repository.readAggregate()), null);
    const frozen = harness.repository.readAggregate();
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "agent_transcript_finalized",
            itemId: "late",
            text: "Rejected late text",
            generation: 1,
            sequence: 20,
          },
          undefined,
          { deferEffectExecution: true },
        ),
      ),
    ).resolves.toEqual({ accepted: false, transcriptChanged: false });
    expect(harness.repository.readAggregate().transcriptCapture).toEqual(frozen.transcriptCapture);
    expect(harness.repository.readAggregate().transcriptRevision).toBe(frozen.transcriptRevision);
  });

  it("does not return a publication signal when aggregate persistence fails", async () => {
    const harness = setupCoordinator({ now: 1_700_000_002_000 });
    harness.durable.storage.sql.exec(
      `CREATE TRIGGER fail_revision BEFORE UPDATE OF finalization_state_json ON runtime_controller_state BEGIN SELECT RAISE(ABORT, 'revision_write_failed'); END`,
    );
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "agent_transcript_finalized",
            itemId: "assistant",
            text: "Must not publish",
            generation: 1,
            sequence: 1,
          },
          undefined,
          { deferEffectExecution: true },
        ),
      ),
    ).rejects.toThrow("revision_write_failed");
    expect(readFinalizationTranscriptTurns(harness.repository.readAggregate())).toEqual([]);
  });

  it("applies overdue work before an incoming observation and preserves the winner", async () => {
    const harness = setupCoordinator({ now: 1_700_000_061_001 });

    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 1_700_000_061_001,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );

    expect(harness.repository.readAggregate().state).toMatchObject({
      stage: "draining",
      endReason: "participant_disconnected",
      source: "presence_timeout",
    });
    expect(harness.alarmRequests.at(-1)).toBeTypeOf("number");
  });

  it("reloads execution state after each effect consequence", async () => {
    const sentCommandTypes: string[] = [];
    const harness = setupCoordinator({
      now: 1_700_000_002_000,
      provider: provider({
        sendFinalizationOperation: (command) => {
          sentCommandTypes.push(command.kind);
          return { status: "dispatched" };
        },
      }),
    });

    await Effect.runPromise(
      harness.coordinator.acceptObservation({
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 1_700_000_002_000,
      }),
    );

    const aggregate = harness.repository.readAggregate();
    expect(sentCommandTypes).toEqual(["stop_output", "close_input"]);
    expect(aggregate.state.effects.every(({ status }) => status !== "pending")).toBe(true);
    expect(aggregate.state.stage).toBe("draining");
  });

  it("starts no provider operation when the durable dispatch claim fails", async () => {
    const calls: unknown[] = [];
    const harness = setupCoordinator({
      now: 1_700_000_002_000,
      provider: provider({
        sendFinalizationOperation: (command) => {
          calls.push(command);
          return { status: "dispatched" };
        },
        release: async () => {
          calls.push("hangup");
          return { status: "close_unconfirmed" };
        },
      }),
    });
    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 1_700_000_002_000,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );

    calls.length = 0; // Urgent Ending containment has already completed.
    const before = harness.repository.readAggregate();
    harness.durable.storage.sql.exec(
      `CREATE TRIGGER fail_claim BEFORE UPDATE OF finalization_state_json ON runtime_controller_state BEGIN SELECT RAISE(ABORT, 'dispatch_claim_failed'); END`,
    );

    await expect(
      Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork()),
    ).rejects.toThrow("dispatch_claim_failed");

    expect(calls).toEqual([]);
    expect(harness.repository.readAggregate()).toEqual(before);
  });

  it("reconciles a durable claim when repository failure follows commit, without dispatch or reconstruction", async () => {
    let armed = false;
    const commands: EndingOperation[] = [];
    const harness = setupCoordinator({
      now: 1_700_000_002_000,
      provider: provider({
        sendFinalizationOperation: (command) => {
          commands.push(command);
          return { status: "dispatched" };
        },
      }),
      repositoryCrashInjector: (point) => {
        if (armed && point === "after_aggregate_write") {
          armed = false;
          throw new Error("claim_committed_before_defect");
        }
      },
    });
    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 1_700_000_002_000,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );

    commands.length = 0; // Urgent Ending containment has already completed.
    armed = true;
    await expect(
      Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork()),
    ).rejects.toThrow("claim_committed_before_defect");
    expect(commands).toEqual([]);
    expect(
      harness.repository.readAggregate().state.effects.find(({ kind }) => kind === "close_input"),
    ).toMatchObject({ status: "uncertain", attemptCount: 1 });
    // The claimed input closure is never replayed.
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(commands).toEqual([]);
  });

  it("contains an interrupted socket send after reconstruction without sending it twice", async () => {
    const calls: EndingOperation[] = [];
    const harness = setupCoordinator({
      now: 1_700_000_002_000,
      provider: provider({
        sendFinalizationOperation: (command) => {
          calls.push(command);
          if (command.kind === "close_input") throw new Error("socket_send_interrupted");
          return { status: "dispatched" };
        },
      }),
    });
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation({
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 1_700_000_002_000,
        }),
      ),
    ).rejects.toThrow("socket_send_interrupted");
    const restored = harness.reconstruct();
    restored.initializeRestoredState();
    restored.initializeRestoredState();
    await Effect.runPromise(restored.executeSelectedRuntimeWork());
    await Effect.runPromise(restored.executeSelectedRuntimeWork());

    expect(calls.filter((command) => command.kind === "close_input")).toHaveLength(1);
    expect(
      harness.repository.readAggregate().state.effects.find(({ kind }) => kind === "close_input"),
    ).toMatchObject({ status: "uncertain", attemptCount: 1 });
    expect(
      harness.events.filter(({ name }) => name === "runtime.provider_command_interrupted"),
    ).toHaveLength(1);
  });

  it("retries interrupted hashing after reconstruction and freezes exactly one result", async () => {
    const harness = setupCoordinator({ now: 1_700_000_012_000 });
    harness.repository.persistAggregate(
      finalizingAggregate(harness.repository.readAggregate()),
      null,
    );
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("hash_interrupted"))
      .mockImplementation(realDigest);

    await expect(
      Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork()),
    ).rejects.toThrow("hash_interrupted");
    const restored = harness.reconstruct();
    restored.initializeRestoredState();
    await Effect.runPromise(restored.executeSelectedRuntimeWork());
    await Effect.runPromise(restored.executeSelectedRuntimeWork());

    expect(digest).toHaveBeenCalledTimes(2);
    expect(harness.repository.readEventsByName("runtime.controller_completed")).toHaveLength(1);
    expect(harness.repository.readAggregate().state.stage).toBe("ended");
    expect(harness.repository.readAggregate().transcriptDigest).toBe(
      "sha256:d5fb095584e9f878eda4919412601f834c18fc24b3310d16ce21830a025a95f8",
    );
  });

  it("rejects a stale digest if a newer persisted transcript replaces the suspended input", async () => {
    // Finalizing ingress rejects new text. This fixture exercises the defensive
    // revision contract against a persisted-state replacement during hashing.
    const harness = setupCoordinator({ now: 1_700_000_012_000 });
    const live = harness.repository.readAggregate();
    harness.repository.persistAggregate(finalizingAggregate(live), null);
    const newerLive = advanceInterviewFinalization(live, {
      kind: "participant_answer_transcribed",
      itemId: "accepted",
      text: "Newer accepted transcript",
      generation: 1,
      sequence: 1,
    }).aggregate;
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseHash: () => void = () => {
      throw new Error("Hash has not started.");
    };
    let startedHash: () => void = () => {
      throw new Error("Hash start has not been registered.");
    };
    const hashStarted = new Promise<void>((resolve) => {
      startedHash = resolve;
    });
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(async (algorithm, input) => {
        const value = await realDigest(algorithm, input);
        startedHash();
        return new Promise<ArrayBuffer>((resolve) => {
          releaseHash = () => resolve(value);
        });
      })
      .mockImplementation(realDigest);
    const executing = Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    await hashStarted;
    harness.repository.persistAggregate(finalizingAggregate(newerLive), null);
    releaseHash();
    await executing;

    const aggregate = harness.repository.readAggregate();
    expect(digest).toHaveBeenCalledTimes(2);
    expect(aggregate.transcriptRevision).toBe(1);
    expect(aggregate.transcriptDigest).toBe(
      "sha256:c50e595dcc1036d9a7bdfd0e9ae35353761f5268eeffdb1371209e8bb8f5e6fd",
    );
    expect(aggregate.state.stage).toBe("ended");
    expect(readFinalizationTranscriptTurns(aggregate)).toEqual([
      { role: "participant", text: "Newer accepted transcript" },
    ]);
  });

  it("recomputes after hashed-result feedback fails to persist", async () => {
    const harness = setupCoordinator({ now: 1_700_000_012_000 });
    harness.repository.persistAggregate(
      finalizingAggregate(harness.repository.readAggregate()),
      null,
    );
    harness.durable.storage.sql.exec(
      `CREATE TRIGGER fail_digest_feedback BEFORE UPDATE OF transcript_digest ON runtime_controller_state WHEN NEW.transcript_digest IS NOT NULL BEGIN SELECT RAISE(ABORT, 'digest_feedback_failed'); END`,
    );
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(realDigest);

    await expect(
      Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork()),
    ).rejects.toThrow("digest_feedback_failed");
    expect(harness.repository.readAggregate().transcriptDigest).toBeNull();
    harness.durable.storage.sql.exec("DROP TRIGGER fail_digest_feedback");
    const restored = harness.reconstruct();
    restored.initializeRestoredState();
    await Effect.runPromise(restored.executeSelectedRuntimeWork());

    expect(digest).toHaveBeenCalledTimes(2);
    expect(harness.repository.readAggregate().state.stage).toBe("ended");
    expect(harness.repository.readAggregate().transcriptDigest).toBe(
      "sha256:d5fb095584e9f878eda4919412601f834c18fc24b3310d16ce21830a025a95f8",
    );
  });

  it("reconstruction after digest feedback preserves the frozen result without hashing again", async () => {
    const harness = setupCoordinator({ now: 1_700_000_012_000 });
    harness.repository.persistAggregate(
      finalizingAggregate(harness.repository.readAggregate()),
      null,
    );
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(realDigest);
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    const frozen = harness.repository.readAggregate();
    const restored = harness.reconstruct();
    restored.initializeRestoredState();
    await Effect.runPromise(restored.executeSelectedRuntimeWork());
    await Effect.runPromise(restored.executeSelectedRuntimeWork());

    expect(digest).toHaveBeenCalledTimes(1);
    expect(harness.repository.readAggregate()).toEqual(frozen);
  });

  it("keeps hashing single-flight and rejects late text while the cutoff result is pending", async () => {
    let now = 1_700_000_011_999;
    const harness = setupCoordinator({ now: () => now });
    harness.repository.persistAggregate(
      finalizingAggregate(harness.repository.readAggregate()),
      null,
    );
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseHash: () => void = () => {
      throw new Error("Hash has not started.");
    };
    let startedHash: () => void = () => {
      throw new Error("Hash start has not been registered.");
    };
    const hashStarted = new Promise<void>((resolve) => {
      startedHash = resolve;
    });
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(async (algorithm, input) => {
        const value = await realDigest(algorithm, input);
        startedHash();
        return new Promise<ArrayBuffer>((resolve) => {
          releaseHash = () => resolve(value);
        });
      })
      .mockImplementation(realDigest);
    const executing = Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    await hashStarted;
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    now = 1_700_000_012_001;
    await expect(
      Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "participant_answer_transcribed",
            itemId: "late",
            text: "Rejected during hash",
            generation: 1,
            sequence: 1,
            observedAt: now,
          },
          undefined,
          { deferEffectExecution: true },
        ),
      ),
    ).resolves.toEqual({ accepted: false, transcriptChanged: false });
    releaseHash();
    await executing;
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());

    expect(digest).toHaveBeenCalledTimes(1);
    const aggregate = harness.repository.readAggregate();
    expect(aggregate.transcriptRevision).toBe(0);
    expect(aggregate.state).toMatchObject({
      stage: "ended",
      completion: { endReason: "participant_stopped", finalizationCutoffAt: 1_700_000_012_000 },
    });
    if (aggregate.state.stage !== "ended") throw new Error("Expected frozen result.");
    expect(readFinalizationTranscriptTurns(aggregate)).toEqual([]);
  });

  it("starts no work for an already interrupted Effect caller, then progresses in the same instance", async () => {
    const commands: EndingOperation[] = [];
    const harness = setupCoordinator({
      now: 1_700_000_002_000,
      provider: provider({
        sendFinalizationOperation: (command) => {
          commands.push(command);
          return { status: "dispatched" };
        },
      }),
    });
    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 1_700_000_002_000,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );

    commands.length = 0; // Urgent Ending containment has already completed.
    const before = harness.repository.readAggregate();
    const abort = new AbortController();
    abort.abort();
    const exit = await Effect.runPromiseExit(
      harness.coordinator.executeSelectedRuntimeWorkEffect(),
      { signal: abort.signal },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(commands).toEqual([]);
    expect(harness.repository.readAggregate()).toEqual(before);
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(commands.map(({ kind }) => kind)).toEqual(["close_input"]);
  });

  it.each(["after_attempt_before_dispatch", "after_dispatch_before_outcome"] as const)(
    "reconciles an interrupted claimed socket operation at %s without replay in the surviving instance",
    async (point) => {
      const abort = new AbortController();
      const commands: EndingOperation[] = [];
      let interruptedId: string | undefined;
      const harness = setupCoordinator({
        now: 1_700_000_002_000,
        provider: provider({
          sendFinalizationOperation: (command) => {
            commands.push(command);
            return { status: "dispatched" };
          },
        }),
        effectCrashInjector: (observed, effect) => {
          if (observed === point && effect.kind === "close_input") {
            interruptedId = effect.id;
            abort.abort();
          }
        },
      });
      await Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "end_requested",
            reason: "participant_stopped",
            source: "browser_request",
            at: 1_700_000_002_000,
          },
          undefined,
          { deferEffectExecution: true },
        ),
      );
      const exit = await Effect.runPromiseExit(
        harness.coordinator.executeSelectedRuntimeWorkEffect(),
        { signal: abort.signal },
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // Claim and synchronous dispatch form one admitted prefix. An interrupt
      // requested within it is observed at the next real Effect boundary.
      expect(commands.filter(({ kind }) => kind === "close_input")).toHaveLength(1);
      expect(
        harness.repository.readAggregate().state.effects.find(({ id }) => id === interruptedId),
      ).toMatchObject({ status: "uncertain", attemptCount: 1 });
      await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
      expect(commands.filter(({ kind }) => kind === "close_input")).toHaveLength(1);
      expect(
        harness.events.find(({ name }) => name === "runtime.provider_command_interrupted")?.payload,
      ).toMatchObject({ exitKind: "interruption" });
    },
  );

  it("reconciles only the exiting claim while retaining unrelated in-flight durable evidence", async () => {
    const harness = setupCoordinator({
      now: 1_700_000_002_000,
      effectCrashInjector: (point, effect) => {
        if (point === "after_attempt_before_dispatch" && effect.kind === "stop_output")
          throw new Error("claimed_local_defect");
      },
    });
    const seeded = withInterruptedEffect(harness.repository.readAggregate());
    harness.repository.persistAggregate(seeded.aggregate, null);
    const other = seeded.aggregate.state.effects.find(({ id }) => id === seeded.effectId);
    await expect(
      Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork()),
    ).rejects.toThrow("claimed_local_defect");
    expect(
      harness.repository.readAggregate().state.effects.find(({ id }) => id === seeded.effectId),
    ).toEqual(other);
    expect(
      harness.repository.readAggregate().state.effects.find(({ kind }) => kind === "stop_output"),
    ).toMatchObject({ status: "uncertain", attemptCount: 1 });
    expect(
      harness.events.find(({ name }) => name === "runtime.provider_command_interrupted")?.payload,
    ).toMatchObject({ effectKind: "stop_output", exitKind: "defect" });
  });

  it("retains the exiting owner when local reconciliation fails and retries its write without provider replay", async () => {
    const commands: EndingOperation[] = [];
    const harness = setupCoordinator({
      now: 1_700_000_002_000,
      provider: provider({
        sendFinalizationOperation: (command) => {
          commands.push(command);
          return { status: "dispatched" };
        },
      }),
      effectCrashInjector: (point, effect) => {
        if (point === "after_dispatch_before_outcome" && effect.kind === "close_input")
          throw new Error("dispatch_defect");
      },
    });
    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 1_700_000_002_000,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );

    commands.length = 0; // Urgent Ending containment has already completed.
    harness.durable.storage.sql.exec(
      `CREATE TRIGGER fail_reconcile BEFORE UPDATE OF finalization_state_json ON runtime_controller_state WHEN json_extract(NEW.finalization_state_json, '$.state.effects[0].status') = 'uncertain' BEGIN SELECT RAISE(ABORT, 'reconcile_write_failed'); END`,
    );
    await expect(
      Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork()),
    ).rejects.toThrow();
    const first = commands[0];
    expect(first?.kind).toBe("close_input");
    harness.durable.storage.sql.exec("DROP TRIGGER fail_reconcile");
    // The retained first owner's write must succeed before any new work is admitted.
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(
      harness.repository.readAggregate().state.effects.find(({ id }) => id === first?.commandId),
    ).toMatchObject({ status: "uncertain", attemptCount: 1 });
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(commands.map(({ kind }) => kind)).toEqual(["close_input"]);
  });

  it("contains a late native hangup after interruption and preserves original cutoff and terminal result", async () => {
    let now = 1_700_000_011_001;
    const started = deferred<void>();
    const hangup = deferred<SessionReleaseAnswer>();
    let calls = 0;
    const harness = setupCoordinator({
      now: () => now,
      provider: provider({
        release: () => {
          calls += 1;
          started.resolve();
          return hangup.promise;
        },
      }),
    });
    harness.repository.persistAggregate(closingAggregate(harness.repository.readAggregate()), null);
    const abort = new AbortController();
    const running = Effect.runPromiseExit(harness.coordinator.executeSelectedRuntimeWorkEffect(), {
      signal: abort.signal,
    });
    await started.promise;
    abort.abort();
    expect(Exit.isFailure(await running)).toBe(true);
    expect(
      harness.repository
        .readAggregate()
        .state.effects.find(({ kind }) => kind === "release_session"),
    ).toMatchObject({ status: "uncertain", attemptCount: 1 });
    now = 1_700_000_012_001;
    await Effect.runPromise(harness.coordinator.handleAlarmInvocation());
    const frozen = harness.repository.readAggregate();
    expect(frozen.state).toMatchObject({
      stage: "ended",
      completion: { finalizationCutoffAt: 1_700_000_012_000 },
    });
    hangup.resolve({ status: "closed" });
    await hangup.promise;
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(harness.repository.readAggregate()).toEqual(frozen);
    expect(calls).toBe(1);
    expect(harness.repository.readEventsByName("runtime.controller_completed")).toHaveLength(1);
  });

  it("rejects a late hangup from a superseded generation and reconciles its exact claim", async () => {
    const started = deferred<void>();
    const hangup = deferred<SessionReleaseAnswer>();
    let calls = 0;
    const harness = setupCoordinator({
      now: 1_700_000_011_001,
      provider: provider({
        release: () => {
          calls += 1;
          started.resolve();
          return hangup.promise;
        },
      }),
    });
    harness.repository.persistAggregate(closingAggregate(harness.repository.readAggregate()), null);
    const running = Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    await started.promise;
    const current = harness.repository.readAggregate();
    harness.repository.persistAggregate(
      { ...current, providerGeneration: current.providerGeneration + 1 },
      null,
    );
    hangup.resolve({ status: "closed" });
    await running;
    const settled = harness.repository.readAggregate();
    expect(settled.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: false,
    });
    expect(settled.state.effects.find(({ kind }) => kind === "release_session")).toMatchObject({
      status: "uncertain",
      attemptCount: 1,
    });
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(calls).toBe(1);
    expect(harness.events.filter(({ name }) => name === "realtime.close_finished")).toEqual([]);
  });

  it("reconciles interruption while draining before terminal hangup admission, then ignores late drain", async () => {
    const started = deferred<void>();
    const drain = deferred<void>();
    let barriers = 0;
    let calls = 0;
    const harness = setupCoordinator({
      now: 1_700_000_011_001,
      provider: provider({
        release: async () => {
          calls += 1;
          return { status: "closed" };
        },
        drain: () => {
          started.resolve();
          return drain.promise;
        },
        closeBarrier: (accepted) => {
          barriers += 1;
          return accepted;
        },
      }),
    });
    harness.repository.persistAggregate(closingAggregate(harness.repository.readAggregate()), null);
    const abort = new AbortController();
    const running = Effect.runPromiseExit(harness.coordinator.executeSelectedRuntimeWorkEffect(), {
      signal: abort.signal,
    });
    await started.promise;
    abort.abort();
    expect(Exit.isFailure(await running)).toBe(true);
    const reconciled = harness.repository.readAggregate();
    expect(reconciled.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: false,
    });
    expect(reconciled.state.effects.find(({ kind }) => kind === "release_session")).toMatchObject({
      status: "uncertain",
      attemptCount: 1,
    });
    drain.resolve();
    await drain.promise;
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(harness.repository.readAggregate()).toEqual(reconciled);
    expect(barriers).toBe(0);
    expect(calls).toBe(1);
  });

  it("retries interrupted hashing in the same instance and rejects its late completion", async () => {
    const harness = setupCoordinator({ now: 1_700_000_012_000 });
    harness.repository.persistAggregate(
      finalizingAggregate(harness.repository.readAggregate()),
      null,
    );
    const started = deferred<void>();
    const late = deferred<ArrayBuffer>();
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const hashing = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(() => {
        started.resolve();
        return late.promise;
      })
      .mockImplementation(realDigest);
    const abort = new AbortController();
    const running = Effect.runPromiseExit(harness.coordinator.executeSelectedRuntimeWorkEffect(), {
      signal: abort.signal,
    });
    await started.promise;
    abort.abort();
    expect(Exit.isFailure(await running)).toBe(true);
    expect(harness.alarmRequests.at(-1)).toBe(1_700_000_013_000);
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    const frozen = harness.repository.readAggregate();
    expect(frozen.state.stage).toBe("ended");
    expect(frozen.transcriptDigest).toBe(
      "sha256:d5fb095584e9f878eda4919412601f834c18fc24b3310d16ce21830a025a95f8",
    );
    late.resolve(new ArrayBuffer(32));
    await late.promise;
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(harness.repository.readAggregate()).toEqual(frozen);
    expect(hashing).toHaveBeenCalledTimes(2);
    expect(harness.repository.readEventsByName("runtime.controller_completed")).toHaveLength(1);
  });

  it("retains the production Promise owner's task after its caller stops waiting", async () => {
    const retained: Promise<void>[] = [];
    const started = deferred<void>();
    const hangup = deferred<SessionReleaseAnswer>();
    const harness = setupCoordinator({
      now: 1_700_000_011_001,
      background: (task) => retained.push(task),
      provider: provider({
        release: () => {
          started.resolve();
          return hangup.promise;
        },
      }),
    });
    harness.repository.persistAggregate(closingAggregate(harness.repository.readAggregate()), null);
    void Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    await started.promise;
    expect(retained).toHaveLength(1);
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    expect(
      harness.repository
        .readAggregate()
        .state.effects.find(({ kind }) => kind === "release_session")?.status,
    ).toBe("sending");
    hangup.resolve({ status: "close_unconfirmed" });
    await retained[0];
    expect(
      harness.repository
        .readAggregate()
        .state.effects.find(({ kind }) => kind === "release_session")?.status,
    ).toBe("dispatched");
  });

  it("reports a background-only owner's defect after the foreground observer has left", async () => {
    const retained: Promise<void>[] = [];
    const commands: EndingOperation[] = [];
    const harness = setupCoordinator({
      now: 1_700_000_002_000,
      background: (task) => retained.push(task),
      provider: provider({
        sendFinalizationOperation: (command) => {
          commands.push(command);
          return { status: "dispatched" };
        },
      }),
      effectCrashInjector: (point) => {
        if (point === "after_dispatch_before_outcome")
          throw new Error("unobserved_foreground_defect");
      },
    });
    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "end_requested",
          reason: "participant_stopped",
          source: "browser_request",
          at: 1_700_000_002_000,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );

    commands.length = 0; // Urgent Ending containment has already completed.
    // The departed foreground observer ignores its own rejected waiter. The DO's
    // distinct retained task must still make the owner failure observable.
    void Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork()).catch(() => undefined);
    await expect(retained[0]).rejects.toThrow("unobserved_foreground_defect");
    expect(
      harness.repository
        .readAggregate()
        .state.effects.find(({ id }) => id === commands[0]?.commandId),
    ).toMatchObject({ status: "uncertain", attemptCount: 1 });
    expect(commands).toHaveLength(1);
  });

  it("retains all competing canonical observations", async () => {
    const harness = setupCoordinator({ now: 1_700_000_002_000 });
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        Effect.runPromise(
          harness.coordinator.acceptObservation(
            {
              kind: "participant_answer_transcribed",
              itemId: `item_${index}`,
              text: `Turn ${index}`,
              generation: 1,
              sequence: index + 1,
            },
            undefined,
            { deferEffectExecution: true },
          ),
        ),
      ),
    );
    const aggregate = harness.repository.readAggregate();
    expect(aggregate.transcriptRevision).toBe(40);
    expect(
      readFinalizationTranscriptTurns(aggregate)
        .map(({ text }) => text)
        .sort(),
    ).toEqual(Array.from({ length: 40 }, (_, index) => `Turn ${index}`).sort());
  });

  it("uses the injected clock for observations without their own timestamp", async () => {
    const harness = setupCoordinator({ now: 1_700_000_002_000 });

    await Effect.runPromise(
      harness.coordinator.acceptObservation(
        {
          kind: "reply_started",
          responseId: "response_before_deadline",
          generation: 1,
          sequence: 1,
        },
        undefined,
        { deferEffectExecution: true },
      ),
    );

    expect(harness.repository.readAggregate().state.stage).toBe("live");
  });

  it.each([
    { label: "immediately before", offset: -1, expectedTurns: 1 },
    { label: "exactly at", offset: 0, expectedTurns: 0 },
  ])(
    "arbitrates receipt-time evidence $label the finalization cutoff",
    async ({ offset, expectedTurns }) => {
      let now = 1_700_000_002_000;
      const harness = setupCoordinator({ now: () => now });
      const live = harness.repository.readAggregate();
      harness.repository.persistAggregate(
        {
          ...live,
          runtimeUsage: createRuntimeUsageAccounting(),
          applicationTranscriptProof: {
            liveAt: 1_700_000_001_000,
            interrupted: false,
            obligations: [],
            closeBarrier: null,
            result: null,
          },
        },
        null,
      );
      await Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "participant_answer_created",
            itemId: "participant",
            generation: 1,
            sequence: 1,
            observedAt: now - 1,
          },
          undefined,
          { deferEffectExecution: true },
        ),
      );
      await Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "end_requested",
            reason: "participant_stopped",
            source: "browser_request",
            at: now,
          },
          undefined,
          { deferEffectExecution: true },
        ),
      );
      const ending = harness.repository.readAggregate();
      if (ending.state.stage === "live" || ending.state.stage === "ended") {
        throw new Error("expected_ending");
      }
      const cutoff = ending.state.finalizationCutoffAt;
      now = cutoff + 100;

      await Effect.runPromise(
        harness.coordinator.acceptObservation(
          {
            kind: "participant_answer_transcribed",
            itemId: "participant",
            text: "Cutoff evidence",
            generation: 1,
            sequence: 2,
            observedAt: cutoff + offset,
          },
          undefined,
          { deferEffectExecution: true },
        ),
      );

      expect(readFinalizationTranscriptTurns(harness.repository.readAggregate())).toHaveLength(
        expectedTurns,
      );
    },
  );

  it("recovers interrupted effects once and remembers reconstructed identities", () => {
    const harness = setupCoordinator({ now: 1_700_000_002_000 });
    const interrupted = withInterruptedEffect(harness.repository.readAggregate());
    harness.repository.persistAggregate(interrupted.aggregate, null);

    harness.coordinator.initializeRestoredState();
    harness.coordinator.initializeRestoredState();

    expect(
      harness.repository
        .readAggregate()
        .state.effects.find(({ id }) => id === interrupted.effectId),
    ).toEqual(expect.objectContaining({ status: "uncertain", attemptCount: 1 }));
  });

  // The release step answers whether the session closed (#978); Runtime warns when it did not.
  it.each([
    ["closed", { status: "closed" }, false],
    ["close_unconfirmed", { status: "close_unconfirmed" }, true],
  ] as const)(
    "records the release answer %s in the result's warnings at the cutoff",
    async (_answer, answer, unobserved) => {
      let now = 1_700_000_011_001;
      const harness = setupCoordinator({
        now: () => now,
        provider: provider({ release: async () => answer }),
      });
      harness.repository.persistAggregate(
        closingAggregate(harness.repository.readAggregate()),
        null,
      );
      await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
      now = 1_700_000_012_001;
      await Effect.runPromise(harness.coordinator.handleAlarmInvocation());
      await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
      const state = harness.repository.readAggregate().state;
      if (state.stage !== "ended") throw new Error("Expected the result to be saved.");
      expect(state.completion.warnings.includes("session_close_unconfirmed")).toBe(unobserved);
    },
  );

  it("keeps a failed release's closure unconfirmed and warns of the failure", async () => {
    let drained = 0;
    const providerCapability = provider({
      release: async () => ({
        status: "close_unconfirmed",
        failure: { status: "failed", timedOut: false, code: "session_release_failed" },
      }),
      drain: async () => {
        drained += 1;
      },
      closeBarrier: (accepted) => accepted,
    });
    const harness = setupCoordinator({ now: 1_700_000_011_001, provider: providerCapability });
    harness.repository.persistAggregate(closingAggregate(harness.repository.readAggregate()), null);

    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());

    expect(drained).toBe(0);
    const aggregate = harness.repository.readAggregate();
    expect(aggregate.state).toMatchObject({
      stage: "closing_provider",
      sessionClosed: false,
      warnings: ["session_release_failed"],
    });
    expect(aggregate.state.effects.find(({ kind }) => kind === "release_session")?.status).toBe(
      "failed",
    );
  });

  it("uses only the remaining cutoff budget for a pre-cutoff hangup", async () => {
    let timeoutCapMs: number | undefined;
    const harness = setupCoordinator({
      now: 1_700_000_011_500,
      provider: provider({
        release: async (_providerCallId, timeoutCap) => {
          timeoutCapMs = timeoutCap;
          return { status: "close_unconfirmed" };
        },
      }),
    });
    harness.repository.persistAggregate(closingAggregate(harness.repository.readAggregate()), null);

    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());

    expect(timeoutCapMs).toBe(500);
  });

  it.each([
    { stage: "finalizing" as const, offset: -2_000, expectedTimeoutCapMs: 2_000 },
    { stage: "ended" as const, offset: -2_000, expectedTimeoutCapMs: 2_000 },
    { stage: "ended" as const, offset: 0, expectedTimeoutCapMs: undefined },
    { stage: "ended" as const, offset: 8_000, expectedTimeoutCapMs: undefined },
  ])(
    "caps a retained $stage hangup at cutoff$offset without changing the frozen result",
    async ({ stage, offset, expectedTimeoutCapMs }) => {
      let timeoutCapMs: number | undefined;
      const base = setupCoordinator({ now: 1_700_000_002_000 });
      const retained = withRetainedPendingHangup(
        stage === "finalizing"
          ? finalizingAggregate(base.repository.readAggregate())
          : endedAggregate(base.repository.readAggregate()),
      );
      const cutoffAt =
        retained.state.stage === "ended"
          ? retained.state.completion.finalizationCutoffAt
          : "finalizationCutoffAt" in retained.state
            ? retained.state.finalizationCutoffAt
            : (() => {
                throw new Error("Expected finalization cutoff.");
              })();
      const frozenResult =
        retained.state.stage === "ended"
          ? {
              completion: retained.state.completion,
              frozenTranscript: retained.transcriptCapture,
            }
          : null;
      const harness = setupCoordinator({
        now: cutoffAt + offset,
        provider: provider({
          release: async (_providerCallId, timeoutCap) => {
            timeoutCapMs = timeoutCap;
            return { status: "close_unconfirmed" };
          },
        }),
      });
      harness.repository.persistAggregate(retained, null);

      await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());

      expect(timeoutCapMs).toBe(expectedTimeoutCapMs);
      const recovered = harness.repository.readAggregate();
      expect(recovered.state.effects.find(({ kind }) => kind === "release_session")?.status).toBe(
        "dispatched",
      );
      if (frozenResult !== null) {
        expect(recovered.state.stage).toBe("ended");
        if (recovered.state.stage !== "ended") throw new Error("Expected frozen result.");
        expect({
          completion: recovered.state.completion,
          frozenTranscript: recovered.transcriptCapture,
        }).toEqual(frozenResult);
      }
    },
  );

  it("uses the technical timeout when cutoff passes before dispatch begins", async () => {
    let afterSelection = false;
    let timeoutCapMs: number | undefined;
    const harness = setupCoordinator({
      now: () => (afterSelection ? 1_700_000_012_001 : 1_700_000_011_500),
      provider: provider({
        release: async (_providerCallId, timeoutCap) => {
          timeoutCapMs = timeoutCap;
          return { status: "close_unconfirmed" };
        },
      }),
    });
    const closing = closingAggregate(harness.repository.readAggregate());
    const hangupEffectId = closing.state.effects.find(({ kind }) => kind === "release_session")?.id;
    if (hangupEffectId === undefined) throw new Error("Expected provider hangup effect.");
    const markEffectSending = harness.repository.markEffectSending.bind(harness.repository);
    vi.spyOn(harness.repository, "markEffectSending").mockImplementation((effectId) => {
      markEffectSending(effectId);
      if (effectId === hangupEffectId) afterSelection = true;
    });
    harness.repository.persistAggregate(closing, null);

    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());

    expect(timeoutCapMs).toBeUndefined();
  });

  it("dispatches one retained pending hangup after cutoff without mutating the frozen result", async () => {
    let hangupCalls = 0;
    let timeoutCapMs: number | undefined = 0;
    const harness = setupCoordinator({
      now: 1_700_000_020_000,
      provider: provider({
        connected: false,
        release: async (_providerCallId, timeoutCap) => {
          hangupCalls += 1;
          timeoutCapMs = timeoutCap;
          return { status: "close_unconfirmed" };
        },
      }),
    });
    const ended = endedAggregate(harness.repository.readAggregate());
    const hangup = ended.state.effects.find(({ kind }) => kind === "release_session");
    if (ended.state.stage !== "ended" || hangup === undefined) {
      throw new Error("Expected ended aggregate with hangup history.");
    }
    const frozenResult = {
      completion: ended.state.completion,
      frozenTranscript: ended.transcriptCapture,
    };
    harness.repository.persistAggregate(
      {
        ...ended,
        state: {
          ...ended.state,
          effects: ended.state.effects.map((effect) =>
            effect.id === hangup.id
              ? { ...effect, status: "pending" as const, attemptCount: 0 }
              : effect,
          ),
        },
      },
      null,
    );

    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());
    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());

    const recovered = harness.repository.readAggregate();
    expect(hangupCalls).toBe(1);
    expect(timeoutCapMs).toBeUndefined();
    expect(recovered.state).toMatchObject({ stage: "ended" });
    if (recovered.state.stage !== "ended") throw new Error("Expected frozen result.");
    expect({
      completion: recovered.state.completion,
      frozenTranscript: recovered.transcriptCapture,
    }).toEqual(frozenResult);
    expect(recovered.state.effects.find(({ id }) => id === hangup.id)?.status).toBe("dispatched");
  });

  it("dispatches no first provider command after cutoff except the retained hangup", async () => {
    let socketCommands = 0;
    let hangupCalls = 0;
    const harness = setupCoordinator({
      now: 1_700_000_020_000,
      provider: provider({
        sendFinalizationOperation: () => {
          socketCommands += 1;
          return { status: "dispatched" };
        },
        release: async () => {
          hangupCalls += 1;
          return { status: "close_unconfirmed" };
        },
      }),
    });
    const ending = advanceInterviewFinalization(harness.repository.readAggregate(), {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 1_700_000_002_000,
    }).aggregate;
    harness.repository.persistAggregate(ending, null);

    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());

    expect(socketCommands).toBe(0);
    expect(hangupCalls).toBe(1);
    const recovered = harness.repository.readAggregate();
    expect(recovered.state).toMatchObject({
      stage: "ended",
      completion: { endReason: "participant_stopped", finalizationCutoffAt: 1_700_000_012_000 },
    });
    expect(
      recovered.state.effects
        .filter(
          ({ kind }) =>
            kind !== "compute_transcript_digest" &&
            kind !== "release_session" &&
            kind !== "arm_alarm",
        )
        .map(({ status }) => status),
    ).not.toContain("uncertain");
    expect(recovered.state.effects.find(({ kind }) => kind === "close_input")?.status).toBe(
      "failed",
    );
  });

  it("selects terminal publication during an alarm turn", async () => {
    const scheduled: string[] = [];
    const harness = setupCoordinator({
      now: 1_700_000_011_800,
      scheduleTerminal: ({ completion }) => {
        scheduled.push(completion.runId);
        return { scheduled: false, reason: "in_flight" };
      },
    });
    harness.repository.persistAggregate(endedAggregate(harness.repository.readAggregate()), null);

    await Effect.runPromise(harness.coordinator.handleAlarmInvocation());

    expect(scheduled).toEqual(["run_coordinator"]);
  });

  it("feeds a computed digest back through the domain and completes finalization", async () => {
    const harness = setupCoordinator({ now: 1_700_000_012_000 });
    harness.repository.persistAggregate(
      finalizingAggregate(harness.repository.readAggregate()),
      null,
    );

    await Effect.runPromise(harness.coordinator.executeSelectedRuntimeWork());

    const aggregate = harness.repository.readAggregate();
    expect(aggregate.transcriptDigest?.startsWith("sha256:")).toBe(true);
    expect(aggregate.state.stage).toBe("ended");
    expect(
      harness.events.filter(({ name }) => name === "runtime.provider_command_dispatch_claimed"),
    ).toEqual([]);
  });

  it("interrupts a reconstructed application Run before overdue presence/timebox work", async () => {
    const harness = setupCoordinator({ now: 1_700_000_100_000 });
    const liveAt = 1_700_000_001_000;
    harness.repository.persistAggregate(
      {
        ...harness.repository.readAggregate(),
        runtimeUsage: createRuntimeUsageAccounting(),
        applicationTranscriptProof: {
          liveAt,
          interrupted: false,
          obligations: [],
          closeBarrier: null,
          result: null,
        },
      },
      null,
    );
    harness.coordinator.initializeRestoredState();
    await Effect.runPromise(harness.coordinator.handleAlarmInvocation());
    const aggregate = harness.repository.readAggregate();
    expect(aggregate.state).not.toMatchObject({ stage: "live" });
    expect(aggregate.state).toMatchObject(
      aggregate.state.stage === "ended"
        ? { completion: { endedAt: 1_700_000_100_000, endReason: "runtime_failed" } }
        : { endingStartedAt: 1_700_000_100_000, endReason: "runtime_failed" },
    );
  });

  it("requests the earliest projected wake-up without receiving platform alarm APIs", async () => {
    const harness = setupCoordinator({ now: 1_700_000_002_000 });

    await Effect.runPromise(harness.coordinator.requestWakeUp());

    expect(harness.alarmRequests.at(-1)).toBe(1_700_000_016_000);
  });
});

function setupCoordinator({
  now,
  provider: providerCapability = provider(),
  scheduleTerminal = () => ({ scheduled: false, reason: "in_flight" }) as const,
  background = () => undefined,
  effectCrashInjector,
  repositoryCrashInjector,
}: Readonly<{
  now: number | (() => number);
  background?: (task: Promise<void>) => void;
  repositoryCrashInjector?: ConstructorParameters<typeof InterviewFinalizationRepository>[1];
  effectCrashInjector?: ConstructorParameters<
    typeof InterviewFinalizationCoordinator
  >[0]["effectCrashInjector"];
  provider?: InterviewFinalizationCoordinatorProvider;
  scheduleTerminal?: InterviewFinalizationCoordinatorPublication["scheduleTerminal"];
}>) {
  const durable = createTestDurableObjectContext();
  openDatabases.push(durable);
  const repository = new InterviewFinalizationRepository(
    createDurableObjectState(durable.ctx).storage,
    repositoryCrashInjector,
  );
  repository.initialize();
  repository.createSetup({
    runId: "run_coordinator",
    runtimeId: "runtime_coordinator",
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    fakeSessionId: null,
    deliveryTarget: { integration: "test", context: { runId: "run_coordinator" } },
    diagnosticsContext: { surface: "test" },
    transcriptCapture: { sequence: 0, items: [] },
    publication: {
      status: "pending",
      transcriptDelivered: false,
      completionDelivered: false,
      retryAt: null,
      attemptCount: 0,
      deliveredAt: null,
      lastError: null,
    },
  });
  repository.commitSetupToLive({
    runId: "run_coordinator",
    liveEvidenceAt: 1_700_000_001_000,
    transitionAt: 1_700_000_001_000,
    deadlineAt: 1_700_000_061_000,
    presenceGraceUntil: 1_700_000_016_000,
    aggregate: liveFinalizationAggregate({ runId: "run_coordinator", liveAt: 1_700_000_001_000 }),
  });
  const alarmRequests: Array<number | null> = [];
  const events: Array<{ name: string; payload: Readonly<Record<string, unknown>> }> = [];
  const reconstruct = () =>
    new InterviewFinalizationCoordinator({
      storage: {
        repository,
        requestAlarm: (wakeAt) =>
          Effect.sync(() => {
            alarmRequests.push(wakeAt);
          }),
      },
      background: (task) => {
        // Observe immediately in this test adapter while retaining the original
        // rejected waiter, just as the native platform observes waitUntil.
        void task.catch(() => undefined);
        background(task);
      },
      effectCrashInjector,
      provider: providerCapability,
      publication: { scheduleTerminal },
      events: {
        recordEvent: (name, payload = {}) => events.push({ name, payload }),
        recordDiagnostic: (name, payload = {}) => {
          events.push({ name, payload });
          return null;
        },
      },
      now: typeof now === "number" ? () => now : now,
    });
  const coordinator = reconstruct();
  return { coordinator, reconstruct, repository, alarmRequests, events, durable };
}

/** A test session whose release and drain settle as promises, as a pair session's do. */
type ProviderFake = Omit<InterviewFinalizationCoordinatorProvider, "release" | "drain"> &
  Readonly<{
    release(sessionId: string | null, timeoutCapMs?: number): Promise<SessionReleaseAnswer>;
    drain(): Promise<void>;
  }>;

/** The session as Runtime's registry hands it over: release starts when called. */
function provider(overrides: Partial<ProviderFake> = {}): InterviewFinalizationCoordinatorProvider {
  const fake: ProviderFake = {
    connected: true,
    connecting: false,
    feasible: true,
    ensureConnected: () => undefined,
    sendFinalizationOperation: () => ({ status: "dispatched" }),
    release: async () => ({ status: "close_unconfirmed" }),
    drain: async () => undefined,
    closeBarrier: (accepted) => accepted,
    ...overrides,
  };
  return {
    ...fake,
    release: (sessionId, timeoutCapMs) => {
      const released = fake.release(sessionId, timeoutCapMs);
      return Effect.promise(() => released);
    },
    drain: () => Effect.promise(() => fake.drain()),
  };
}

function withInterruptedEffect(aggregate: InterviewFinalizationAggregate) {
  const ending = advanceInterviewFinalization(aggregate, {
    kind: "end_requested",
    reason: "participant_stopped",
    source: "browser_request",
    at: 1_700_000_002_000,
  });
  const effect = ending.aggregate.state.effects.find(({ kind }) => kind === "close_input");
  if (effect === undefined) throw new Error("Expected final-input effect.");
  return {
    effectId: effect.id,
    aggregate: {
      ...ending.aggregate,
      state: {
        ...ending.aggregate.state,
        effects: ending.aggregate.state.effects.map((candidate) =>
          candidate.id === effect.id ? { ...candidate, status: "sending" as const } : candidate,
        ),
      },
    },
  };
}

function closingAggregate(
  aggregate: InterviewFinalizationAggregate,
): InterviewFinalizationAggregate {
  const ending = advanceInterviewFinalization(aggregate, {
    kind: "end_requested",
    reason: "participant_stopped",
    source: "browser_request",
    at: 1_700_000_002_000,
  }).aggregate;
  const settled = settlePendingEffects(ending, 1_700_000_002_000);
  // Provider cleanup begins at the checkpoint while the final item's text is still owed.
  const admitted = advanceInterviewFinalization(settled, {
    kind: "participant_answer_created",
    itemId: "coordinator-final-item",
    generation: settled.providerGeneration,
    sequence: settled.nextProviderSequence,
  }).aggregate;
  return advanceInterviewFinalization(admitted, {
    kind: "deadline_reached",
    deadline: "drain",
    at: 1_700_000_011_000,
  }).aggregate;
}

function endedAggregate(aggregate: InterviewFinalizationAggregate): InterviewFinalizationAggregate {
  const finalizing = finalizingAggregate(aggregate);
  return advanceInterviewFinalization(finalizing, {
    kind: "transcript_digest_computed",
    revision: finalizing.transcriptRevision,
    digest: `sha256:${"a".repeat(64)}`,
    at: 1_700_000_011_500,
  }).aggregate;
}

function finalizingAggregate(
  aggregate: InterviewFinalizationAggregate,
): InterviewFinalizationAggregate {
  const closing = closingAggregate(aggregate);
  const closingSettled = settlePendingEffects(closing, 1_700_000_011_000);
  if (closingSettled.state.stage !== "closing_provider") {
    throw new Error("Expected closing-provider state.");
  }
  return advanceInterviewFinalization(closingSettled, {
    kind: "deadline_reached",
    deadline: "finalization_cutoff",
    at: closingSettled.state.finalizationCutoffAt,
  }).aggregate;
}

function settlePendingEffects(
  aggregate: InterviewFinalizationAggregate,
  at: number,
): InterviewFinalizationAggregate {
  return aggregate.state.effects
    .filter(({ status }) => status === "pending")
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

function withRetainedPendingHangup(
  aggregate: InterviewFinalizationAggregate,
): InterviewFinalizationAggregate {
  const hangup = aggregate.state.effects.find(({ kind }) => kind === "release_session");
  if (hangup === undefined) throw new Error("Expected provider hangup effect.");
  return {
    ...aggregate,
    state: {
      ...aggregate.state,
      effects: aggregate.state.effects.map((effect) =>
        effect.id === hangup.id
          ? { ...effect, status: "pending" as const, attemptCount: 0 }
          : effect,
      ),
    },
  };
}

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => {
    throw new Error("deferred_not_initialized");
  };
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
