import { afterEach, describe, expect, it } from "vitest";

import {
  liveFinalizationAggregate,
  receiveConversationReceipt,
} from "./testing/finalizationFixtures.ts";

import { advanceInterviewFinalization } from "./interviewFinalizationFSM.ts";
import { type InterviewFinalizationAggregate } from "./interviewFinalizationModel.ts";
import {
  InterviewFinalizationRepository,
  type AggregatePersistenceCrashPoint,
} from "./interviewFinalizationRepository.ts";
import {
  createDurableObjectState,
  createTestDurableObjectContext,
} from "./testing/interviewRuntimeControllerTestHarness.ts";

const openDatabases: Array<ReturnType<typeof createTestDurableObjectContext>> = [];

afterEach(() => {
  for (const durable of openDatabases.splice(0)) durable.close();
});

describe("Interview finalization repository recovery", () => {
  it("retains observed application usage before live readiness and seals it on a failed start", () => {
    const { durable, repository } = setupRepository();
    repository.persistSetupProviderObservation(
      {
        sessionId: "call",
        sequence: 1,
        providerEventId: "response-started",
        diagnosticSummary: { type: "response.created" },
      },
      [
        {
          status: "expected",
          componentRole: "speech_to_speech",
          key: "response:1:response-before-live",
        },
      ],
    );
    repository.persistSetupProviderObservation(
      {
        sessionId: "call",
        sequence: 2,
        providerEventId: "response-done",
        diagnosticSummary: { type: "response.done" },
      },
      [
        {
          status: "satisfied",
          componentRole: "speech_to_speech",
          key: "response:1:response-before-live",
          pendingKey: "response:1:response-before-live",
          measurements: [
            {
              componentRole: "speech_to_speech",
              provider: "openai",
              model: "gpt-realtime-2",
              measure: "output_audio",
              unit: "token",
              quantity: 13,
            },
          ],
        },
      ],
    );

    const restored = repositoryFor(durable);
    restored.initialize();
    restored.commitSetupFailure("run_repository", 1_700_000_000_500, 1_700_000_020_000);

    expect(JSON.parse(restored.requireState().completion_json ?? "null")).toEqual({
      runId: "run_repository",
      outcome: "failed_to_start",
      endedAt: 1_700_000_000_500,
      runtimeUsage: {
        completeness: "complete",
        observations: [
          {
            componentRole: "speech_to_speech",
            provider: "openai",
            model: "gpt-realtime-2",
            measure: "output_audio",
            unit: "token",
            quantity: 13,
          },
        ],
      },
    });
    expect(restored.hasProviderEventIdentity("response-started")).toBe(true);
    expect(restored.hasProviderEventIdentity("response-done")).toBe(true);
    expect(restored.requireState()).toMatchObject({
      callback_pending: 1,
      callback_retry_at: 1_700_000_020_000,
      failed_start_publication_cutoff_at: 1_700_000_050_000,
      failed_start_publication_status: "pending",
    });
  });

  it("does not certify complete-empty usage when accepted application accounting is missing", () => {
    const { durable, repository } = setupRepository();
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET runtime_usage_json = NULL WHERE run_id = ?",
      "run_repository",
    );

    repository.commitSetupFailure("run_repository", 1_700_000_000_500, 1_700_000_000_500);

    expect(JSON.parse(repository.requireState().completion_json ?? "null")).toMatchObject({
      runtimeUsage: { completeness: "incomplete", observations: [] },
    });
  });

  it("tracks identity-only cleanup once without rearming it for duplicate identity or answer writes", () => {
    const { repository } = setupRepository();
    repository.commitSetupFailure("run_repository", 1_700_000_000_500, 1_700_000_000_500);
    repository.finishSetupCleanup("run_repository");
    const sealedCompletion = repository.requireState().completion_json;
    const identity = {
      runId: "run_repository",
      sessionId: "rtc_late_identity",
      sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_late_identity",
      upstreamRequestId: "req_late_identity",
      settingsSummary: { model: "gpt-realtime-2" },
    };

    repository.recordSessionIdentity(identity);
    expect(repository.requireState()).toMatchObject({
      session_id: "rtc_late_identity",
      session_reply_json: null,
      setup_cleanup_pending: 1,
    });
    repository.finishSetupCleanup("run_repository");

    repository.recordSessionIdentity(identity);
    repository.recordSessionReply({
      runId: "run_repository",
      sessionId: "rtc_late_identity",
      reply: { sdp: "v=0\r\nlate-answer" },
    });
    repository.recordSessionReply({
      runId: "run_repository",
      sessionId: "rtc_late_identity",
      reply: { sdp: "v=0\r\nlate-answer" },
    });

    expect(repository.requireState()).toMatchObject({
      session_reply_json: JSON.stringify({ sdp: "v=0\r\nlate-answer" }),
      setup_cleanup_pending: 0,
      completion_json: sealedCompletion,
    });
  });

  it.each(["before_aggregate_write", "after_aggregate_write"] as const)(
    "keeps one final-input effect and durable ending event across a crash %s",
    (crashPoint) => {
      const { durable, aggregate } = setupLiveRepository();
      const ending = advanceInterviewFinalization(aggregate, {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 1_700_000_002_000,
      });
      let crashed = false;
      const crashingRepository = repositoryFor(durable, (point) => {
        if (!crashed && point === crashPoint) {
          crashed = true;
          throw new Error(`injected_crash:${point}`);
        }
      });

      expect(() => crashingRepository.persistAggregate(ending.aggregate, ending.events)).toThrow(
        `injected_crash:${crashPoint}`,
      );

      const recoveredRepository = repositoryFor(durable);
      recoveredRepository.initialize();
      const recovered = recoveredRepository.readAggregate();
      const replayed = advanceInterviewFinalization(recovered, {
        kind: "end_requested",
        reason: "participant_stopped",
        source: "browser_request",
        at: 1_700_000_002_000,
      });
      recoveredRepository.persistAggregate(replayed.aggregate, replayed.events);

      const persisted = recoveredRepository.readAggregate();
      expect(
        persisted.state.effects.filter((effect) => effect.kind === "close_input"),
      ).toHaveLength(1);
      expect(events(durable).filter((event) => event === "runtime.ending")).toHaveLength(1);
      expect(persisted.finalInput?.effectId).toBe(
        persisted.state.effects.find((effect) => effect.kind === "close_input")?.id,
      );
    },
  );

  it.each(["before_aggregate_write", "after_aggregate_write"] as const)(
    "restores only durable provider time, identity and Transcript proof after %s",
    (crashPoint) => {
      const { durable, repository, aggregate } = setupLiveRepository();
      const liveAt = 1_700_000_001_000;
      const active: InterviewFinalizationAggregate = {
        ...aggregate,
        providerGeneration: 1,
        runtimeUsage: {
          pending: [],
          processedKeys: [],
          observations: [],
          incomplete: false,
        },
        applicationTranscriptProof: {
          liveAt,
          interrupted: false,
          obligations: [],
          closeBarrier: null,
          result: null,
        },
      };
      const input = advanceInterviewFinalization(active, {
        kind: "participant_answer_created",
        itemId: "proof",
        generation: 1,
        sequence: 1,
        usage: [
          { status: "expected", componentRole: "speech_to_text", key: "speech_to_text:proof" },
        ],
      }).aggregate;
      repository.persistAggregate({ ...input, lastProviderObservationAt: liveAt + 100 }, null);
      const evidence = advanceInterviewFinalization(repository.readAggregate(), {
        kind: "participant_answer_transcribed",
        itemId: "proof",
        contentIndex: 0,
        text: "Final durable evidence",
        generation: 1,
        sequence: 2,
        usage: [
          {
            status: "satisfied",
            componentRole: "speech_to_text",
            key: "speech_to_text:proof:0",
            pendingKey: "speech_to_text:proof",
            measurements: [
              {
                componentRole: "speech_to_text",
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                measure: "input_audio",
                unit: "token",
                quantity: 8,
              },
            ],
          },
        ],
      }).aggregate;
      const crashing = repositoryFor(durable, (point) => {
        if (point === crashPoint) throw new Error("crash");
      });
      expect(() =>
        crashing.persistAggregate({ ...evidence, lastProviderObservationAt: liveAt + 200 }, null, {
          sessionId: "call",
          sequence: 2,
          providerEventId: "final-evidence",
          diagnosticSummary: {},
        }),
      ).toThrow("crash");
      const restored = repositoryFor(durable);
      restored.initialize();
      const accepted = crashPoint === "after_aggregate_write";
      expect(restored.hasProviderEventIdentity("final-evidence")).toBe(accepted);
      expect(restored.readAggregate().lastProviderObservationAt).toBe(
        liveAt + (accepted ? 200 : 100),
      );
      expect(restored.readAggregate().applicationTranscriptProof?.obligations[0]?.status).toBe(
        accepted ? "captured" : "pending",
      );
      expect(restored.readAggregate().runtimeUsage).toMatchObject(
        accepted
          ? {
              pending: [],
              processedKeys: ["speech_to_text:proof", "speech_to_text:proof:0"],
              observations: [{ componentRole: "speech_to_text", quantity: 8 }],
            }
          : {
              pending: [{ componentRole: "speech_to_text", key: "speech_to_text:proof" }],
              processedKeys: [],
              observations: [],
            },
      );
      const interrupted = advanceInterviewFinalization(restored.readAggregate(), {
        kind: "runtime_failure_observed",
        source: "session_disconnected",
        at: liveAt + 300,
      });
      restored.persistAggregate(interrupted.aggregate, interrupted.events);
      let ending = settlePendingEffects(interrupted.aggregate, liveAt + 301);
      ending = advanceInterviewFinalization(ending, {
        kind: "deadline_reached",
        deadline: "drain",
        at: liveAt + 10_000,
      }).aggregate;
      ending = settlePendingEffects(ending, liveAt + 10_001);
      ending = advanceInterviewFinalization(ending, {
        kind: "deadline_reached",
        deadline: "finalization_cutoff",
        at: liveAt + 20_000,
      }).aggregate;
      ending = advanceInterviewFinalization(ending, {
        kind: "transcript_digest_computed",
        revision: ending.transcriptRevision,
        digest: `sha256:${"a".repeat(64)}`,
        at: liveAt + 20_001,
      }).aggregate;
      restored.persistAggregate(ending, null);
      expect(restored.readAggregate().applicationTranscriptProof?.result).toMatchObject({
        endedAt: liveAt + 300,
        transcriptCompleteness: accepted ? "complete" : "incomplete",
        transcriptSnapshot: { turnCount: accepted ? 1 : 0 },
      });
    },
  );

  it.each(["before_aggregate_write", "after_aggregate_write"] as const)(
    "persists the frozen result and publication cutoff atomically across %s",
    (crashPoint) => {
      const { durable, aggregate } = setupLiveRepository();
      const ended = endedAggregate(aggregate);
      if (ended.state.stage !== "ended") throw new Error("Expected ended aggregate.");
      const crashing = repositoryFor(durable, (point) => {
        if (point === crashPoint) throw new Error("crash");
      });

      expect(() => crashing.persistAggregate(ended, null)).toThrow("crash");

      const restored = repositoryFor(durable);
      restored.initialize();
      const persisted = restored.readAggregate();
      if (crashPoint === "before_aggregate_write") {
        // A live Run has no publication, so no cutoff was persisted.
        expect(persisted.state).toEqual(aggregate.state);
      } else {
        expect(persisted.state).toEqual(ended.state);
        if (persisted.state.stage !== "ended") throw new Error("Expected ended aggregate.");
        expect(persisted.state.publication.publicationCutoffAt).toBe(
          ended.state.completion.finalizedAt + 30_000,
        );
      }
    },
  );

  it("accepts a new setup in storage created with the retired NOT NULL duration column", () => {
    const current = createTestDurableObjectContext();
    openDatabases.push(current);
    repositoryFor(current).initialize();
    const [table] = current.storage.sql
      .exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_controller_state'",
      )
      .toArray();
    const legacySchema = table?.sql.replace(
      "live_at INTEGER,",
      "live_at INTEGER,\n        max_duration_ms INTEGER NOT NULL,",
    );
    if (legacySchema === undefined || !legacySchema.includes("max_duration_ms"))
      throw new Error("missing_legacy_schema");
    const legacy = createTestDurableObjectContext();
    openDatabases.push(legacy);
    legacy.storage.sql.exec(legacySchema);

    const repository = repositoryFor(legacy);
    repository.initialize();
    repository.createSetup(repositorySetup);

    expect(repository.requireState("run_repository")).toMatchObject({
      run_id: "run_repository",
      phase: "setup",
    });
  });

  it("rejects a non-setup row without a current aggregate instead of reconstructing it", () => {
    const { durable } = setupRepository();
    durable.storage.sql.exec(
      `UPDATE runtime_controller_state
       SET phase = 'live', live_at = ?, deadline_at = ?, presence_grace_until = ?
       WHERE run_id = ?`,
      1_700_000_001_000,
      1_700_000_061_000,
      1_700_000_016_000,
      "run_repository",
    );
    const before = durable.storage.sql.executions.length;

    const repository = repositoryFor(durable);
    repository.initialize();
    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
    expect(aggregateWrites(durable, before)).toEqual([]);
  });

  it("leaves recognized interrupted-effect interpretation to the coordinator", () => {
    const { durable, repository, aggregate } = setupLiveRepository();
    const draining = advanceInterviewFinalization(aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 1_700_000_002_000,
    });
    const closing = advanceInterviewFinalization(draining.aggregate, {
      kind: "deadline_reached",
      deadline: "drain",
      at: 1_700_000_011_000,
    });
    const interruptedEffect = closing.aggregate.state.effects.find(
      (effect) => effect.kind === "stop_output",
    );
    if (interruptedEffect === undefined) throw new Error("Expected a provider output effect.");
    const interrupted: InterviewFinalizationAggregate = {
      ...closing.aggregate,
      state: {
        ...closing.aggregate.state,
        effects: closing.aggregate.state.effects.map((effect) =>
          effect.id === interruptedEffect.id ? { ...effect, status: "sending" as const } : effect,
        ),
      },
    };
    repository.persistAggregate(interrupted, null);
    const recoveredRepository = repositoryFor(durable);
    recoveredRepository.initialize();
    expect(
      recoveredRepository
        .readAggregate()
        .state.effects.find((effect) => effect.id === interruptedEffect.id),
    ).toEqual(expect.objectContaining({ status: "sending", attemptCount: 0 }));
    recoveredRepository.initialize();
    expect(
      recoveredRepository
        .readAggregate()
        .state.effects.find((effect) => effect.id === interruptedEffect.id),
    ).toEqual(expect.objectContaining({ status: "sending", attemptCount: 0 }));
  });

  it("returns a valid current row with matching projections without rewriting the aggregate", () => {
    const { durable } = setupLiveRepository();
    const before = durable.storage.sql.executions.length;
    const repository = repositoryFor(durable);
    repository.initialize();
    expect(repository.readAggregate().state.stage).toBe("live");
    expect(aggregateWrites(durable, before)).toEqual([]);
  });

  it("round-trips the winning finish identity and both graceful settlements", () => {
    const { durable, repository, aggregate } = setupLiveRepository();
    let graceful = receiveConversationReceipt(aggregate, {
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      responseStatus: "completed",
      generation: 1,
      sequence: 1,
      at: 1_700_000_002_000,
    }).aggregate;
    graceful = advanceInterviewFinalization(graceful, {
      kind: "reply_delivery_stopped",
      responseId: "response_closing",
      generation: 1,
      sequence: 2,
    }).aggregate;
    repository.persistAggregate(graceful, null);

    const restored = repositoryFor(durable);
    restored.initialize();
    expect(restored.readAggregate()).toMatchObject({
      gracefulCompletion: {
        callId: "call_finish",
        responseId: "response_closing",
        responseSettlement: "completed",
        outputAudioSettlement: "stopped",
      },
      providerResponses: [
        {
          responseId: "response_closing",
          status: "completed",
          outputAudio: "stopped",
        },
      ],
    });
  });

  it("round-trips the final-input fence, effect identity, obligation, and quiet deadline", () => {
    const { repository, aggregate } = setupLiveRepository();
    const ending = advanceInterviewFinalization(aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 1_700_000_002_000,
    });

    repository.persistAggregate(ending.aggregate, null);

    expect(repository.readAggregate()).toEqual(ending.aggregate);
    expect(repository.requireState("run_repository")).toMatchObject({
      phase: "ending",
      deadline_at: 1_700_000_012_000,
    });
  });

  it("repairs every aggregate-derived projection and records the repair atomically", () => {
    const { durable, aggregate } = setupLiveRepository();
    durable.storage.sql.exec(
      `UPDATE runtime_controller_state SET
        phase = 'ending', deadline_at = 123, session_generation = 9,
        transcript_json = '{"turns":[{"role":"participant","text":"wrong"}]}',
        transcript_turn_count = 1, pending_close_reason = 'participant_stopped',
        pending_close_source = 'wrong', pending_close_requested_at = 456,
        completion_json = '{}', callback_pending = 1, callback_delivered_at = 789,
        callback_retry_at = 999, callback_attempt_count = 7, callback_last_error = 'wrong',
        transcript_capture_json = '{}', transcript_revision = 4,
        transcript_digest = ?, next_provider_sequence = 4, next_effect_sequence = 5,
        next_event_sequence = 6, frozen_transcript_json = '{}',
        frozen_transcript_revision = 4, frozen_transcript_digest = ?,
        frozen_transcript_turn_count = 1, publication_json = '{}'
       WHERE run_id = 'run_repository'`,
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
    );
    const before = durable.storage.sql.executions.length;

    const repository = repositoryFor(durable);
    repository.initialize();
    expect(repository.requireState()).toMatchObject({
      phase: "live",
      deadline_at: 1_700_000_061_000,
      session_generation: aggregate.providerGeneration,
      transcript_json: JSON.stringify({ turns: [] }),
      transcript_turn_count: 0,
      pending_close_reason: null,
      pending_close_source: null,
      pending_close_requested_at: null,
      completion_json: null,
      callback_pending: 0,
      callback_delivered_at: null,
      callback_retry_at: null,
      callback_attempt_count: 0,
      callback_last_error: null,
      transcript_capture_json: JSON.stringify(aggregate.transcriptCapture),
      transcript_revision: 0,
      transcript_digest: null,
      next_provider_sequence: 1,
      next_effect_sequence: 1,
      next_event_sequence: 1,
      frozen_transcript_json: null,
      frozen_transcript_revision: null,
      frozen_transcript_digest: null,
      frozen_transcript_turn_count: null,
      publication_json: null,
    });
    expect(events(durable)).toContain("runtime.finalization_projection_repaired");
    expect(aggregateWrites(durable, before)).toEqual([true]);
  });

  it("rebuilds non-null terminal and frozen projections from the valid aggregate", () => {
    const { durable, repository, aggregate } = setupLiveRepository();
    const ended = endedAggregate(aggregate);
    repository.persistAggregate(ended, null);
    durable.storage.sql.exec(
      `UPDATE runtime_controller_state SET
        phase = 'live', deadline_at = 123, completion_json = NULL,
        frozen_transcript_json = NULL, frozen_transcript_revision = NULL,
        frozen_transcript_digest = NULL, frozen_transcript_turn_count = NULL,
        callback_pending = 0, callback_retry_at = NULL
       WHERE run_id = 'run_repository'`,
    );

    const recoveredRepository = repositoryFor(durable);
    recoveredRepository.initialize();
    const state = recoveredRepository.requireState();
    if (ended.state.stage !== "ended") throw new Error("Expected an ended aggregate.");
    expect(state).toMatchObject({
      phase: "ended",
      deadline_at: null,
      completion_json: JSON.stringify(ended.state.completion),
      frozen_transcript_json: JSON.stringify({ turns: [] }),
      frozen_transcript_revision: 0,
      frozen_transcript_digest: `sha256:${"a".repeat(64)}`,
      frozen_transcript_turn_count: 0,
      callback_pending: 1,
      callback_retry_at: 1_700_000_010_100,
    });
    expect(events(durable)).toContain("runtime.finalization_projection_repaired");
  });

  it("repairs delivered callback metadata from the canonical aggregate", () => {
    const { durable, repository, aggregate } = setupLiveRepository();
    const deliveredAt = 1_700_000_020_000;
    const ended = endedAggregate(aggregate);
    if (ended.state.stage !== "ended") throw new Error("Expected ended aggregate.");
    const delivered = {
      ...ended,
      state: {
        ...ended.state,
        publication: {
          ...ended.state.publication,
          status: "delivered" as const,
          transcriptDelivered: true as const,
          completionDelivered: true as const,
          retryAt: null,
          attemptCount: 1,
          deliveredAt,
          lastError: null,
        },
      },
    };
    repository.persistAggregate(delivered, null);
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET callback_delivered_at = 123 WHERE run_id = ?",
      "run_repository",
    );

    const recoveredRepository = repositoryFor(durable);
    recoveredRepository.initialize();

    expect(recoveredRepository.requireState().callback_delivered_at).toBe(deliveredAt);
    expect(events(durable)).toContain("runtime.finalization_projection_repaired");
  });

  it("repairs callback failure metadata from the canonical aggregate", () => {
    const { durable, repository, aggregate } = setupLiveRepository();
    const ended = endedAggregate(aggregate);
    if (ended.state.stage !== "ended") throw new Error("Expected ended aggregate.");
    const retryAt = 1_700_000_030_000;
    const lastError = "completion_callback_not_acknowledged";
    const retrying = {
      ...ended,
      state: {
        ...ended.state,
        publication: {
          ...ended.state.publication,
          status: "retrying" as const,
          retryAt,
          attemptCount: 2,
          deliveredAt: null,
          lastError,
        },
      },
    };
    repository.persistAggregate(retrying, null);
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET callback_last_error = 'stale' WHERE run_id = ?",
      "run_repository",
    );

    const recoveredRepository = repositoryFor(durable);
    recoveredRepository.initialize();

    expect(recoveredRepository.requireState().callback_last_error).toBe(lastError);
    expect(events(durable)).toContain("runtime.finalization_projection_repaired");
  });

  it("fails an ordinary mismatched read closed without repairing it", () => {
    const { durable, repository } = setupLiveRepository();
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET phase = 'ending' WHERE run_id = 'run_repository'",
    );
    const before = durable.storage.sql.executions.length;
    expect(() => repository.readState()).toThrow("finalization_projection_mismatch:phase");
    expect(aggregateWrites(durable, before)).toEqual([]);
    expect(
      durable.storage.sql
        .exec<{ phase: string }>(
          "SELECT phase FROM runtime_controller_state WHERE run_id = 'run_repository'",
        )
        .one().phase,
    ).toBe("ending");
  });

  it("fails malformed current state closed and never synthesizes from projections", () => {
    const { durable } = setupLiveRepository();
    const malformed = JSON.stringify({ state: { stage: "live" } });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      malformed,
      "run_repository",
    );
    const repository = repositoryFor(durable);
    repository.initialize();
    repository.initialize();
    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(
      events(durable).filter((event) => event === "runtime.invalid_finalization_state"),
    ).toEqual(["runtime.invalid_finalization_state"]);
    expect(
      durable.storage.sql
        .exec<{ finalization_state_json: string }>(
          "SELECT finalization_state_json FROM runtime_controller_state WHERE run_id = ?",
          "run_repository",
        )
        .one().finalization_state_json,
    ).toBe(malformed);
  });

  it.each(["aggregate", "state", "publication"])(
    "rejects unknown %s fields at persisted-row ingress",
    (target) => {
      const { durable, aggregate } = setupLiveRepository();
      const ended = endedAggregate(aggregate);
      if (ended.state.stage !== "ended") throw new Error("Expected ended aggregate.");
      const malformed =
        target === "aggregate"
          ? { ...aggregate, unexpected: true }
          : target === "state"
            ? { ...aggregate, state: { ...aggregate.state, unexpected: true } }
            : {
                ...ended,
                state: {
                  ...ended.state,
                  publication: { ...ended.state.publication, unexpected: true },
                },
              };
      durable.storage.sql.exec(
        "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
        JSON.stringify(malformed),
        "run_repository",
      );
      const repository = repositoryFor(durable);
      repository.initialize();
      expect(() => repository.readAggregate()).toThrow("invalid_finalization_state");
    },
  );

  it("rejects an obsolete partial aggregate shape without upgrading it", () => {
    const { durable, aggregate } = setupLiveRepository();
    const obsolete = JSON.stringify({
      ...aggregate,
      providerEventIds: ["event_embedded_in_obsolete_shape"],
    });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      obsolete,
      "run_repository",
    );

    const repository = repositoryFor(durable);
    repository.initialize();

    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
    expect(
      durable.storage.sql
        .exec<{ finalization_state_json: string }>(
          "SELECT finalization_state_json FROM runtime_controller_state WHERE run_id = ?",
          "run_repository",
        )
        .one().finalization_state_json,
    ).toBe(obsolete);
  });

  it("fails a cross-field inconsistent final input state closed", () => {
    const { durable, aggregate } = setupLiveRepository();
    const draining = advanceInterviewFinalization(aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 1_700_000_002_000,
    }).aggregate;
    if (draining.state.stage !== "draining" || draining.finalInput === null) {
      throw new Error("Expected a draining aggregate with final input state.");
    }
    const malformed = JSON.stringify({
      ...draining,
      finalInput: {
        ...draining.finalInput,
        obligation: "awaiting_transcription",
        admittedItemId: null,
      },
      state: {
        ...draining.state,
        activeInputItemId: null,
      },
    });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      malformed,
      "run_repository",
    );

    const repository = repositoryFor(durable);
    repository.initialize();

    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
  });

  it("fails duplicate persisted final input commit effects closed", () => {
    const { durable, aggregate } = setupLiveRepository();
    const draining = advanceInterviewFinalization(aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 1_700_000_002_000,
    }).aggregate;
    const duplicateCommitId = `${draining.runId}:${draining.nextEffectSequence}`;
    const malformed = JSON.stringify({
      ...draining,
      nextEffectSequence: draining.nextEffectSequence + 1,
      state: {
        ...draining.state,
        effects: [
          ...draining.state.effects,
          {
            id: duplicateCommitId,
            kind: "close_input",
            status: "failed",
            acceptance: "rejected",
            attemptCount: 1,
          },
        ],
      },
    });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      malformed,
      "run_repository",
    );

    const repository = repositoryFor(durable);
    repository.initialize();

    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
  });

  it("fails closed before a malformed cancel-response effect can be dispatched", () => {
    const { durable, aggregate } = setupLiveRepository();
    const malformed = JSON.stringify({
      ...aggregate,
      state: {
        ...aggregate.state,
        effects: [
          {
            id: "run_repository:1",
            kind: "cancel_reply",
            status: "pending",
            acceptance: "unobserved",
            attemptCount: 0,
          },
        ],
      },
    });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      malformed,
      "run_repository",
    );

    const repository = repositoryFor(durable);
    repository.initialize();

    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
  });

  it("fails closed before a live aggregate can dispatch a finalization provider effect", () => {
    const { durable, aggregate } = setupLiveRepository();
    const malformed = JSON.stringify({
      ...aggregate,
      nextEffectSequence: 2,
      state: {
        ...aggregate.state,
        effects: [
          {
            id: "run_repository:1",
            kind: "release_session",
            status: "pending",
            acceptance: "unobserved",
            attemptCount: 0,
          },
        ],
      },
    });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      malformed,
      "run_repository",
    );

    const repository = repositoryFor(durable);
    repository.initialize();

    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
  });

  it("fails closed before a draining aggregate can dispatch provider-close effects", () => {
    const { durable, aggregate } = setupLiveRepository();
    const draining = advanceInterviewFinalization(aggregate, {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "browser_request",
      at: 1_700_000_002_000,
    }).aggregate;
    const effectId = `run_repository:${draining.nextEffectSequence}`;
    const malformed = JSON.stringify({
      ...draining,
      nextEffectSequence: draining.nextEffectSequence + 1,
      state: {
        ...draining.state,
        effects: [
          ...draining.state.effects,
          {
            id: effectId,
            kind: "release_session",
            status: "pending",
            acceptance: "unobserved",
            attemptCount: 0,
          },
        ],
      },
    });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      malformed,
      "run_repository",
    );

    const repository = repositoryFor(durable);
    repository.initialize();

    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
  });

  it("restores a terminal aggregate with an independently pending provider hangup", () => {
    const { durable, aggregate } = setupLiveRepository();
    const ended = endedAggregate(aggregate);
    const hangup = ended.state.effects.find((effect) => effect.kind === "release_session");
    if (hangup === undefined) throw new Error("Expected a provider hangup effect.");
    const malformed = JSON.stringify({
      ...ended,
      state: {
        ...ended.state,
        effects: ended.state.effects.map((effect) =>
          effect.id === hangup.id ? { ...effect, status: "pending" } : effect,
        ),
      },
    });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      malformed,
      "run_repository",
    );

    const repository = repositoryFor(durable);
    repository.initialize();

    expect(repository.readAggregate().state.effects).toContainEqual({
      ...hangup,
      status: "pending",
    });
    expect(events(durable)).not.toContain("runtime.invalid_finalization_state");
  });

  it("fails closed when duplicate transcript item identities would change a stored digest", () => {
    const { durable, aggregate } = setupLiveRepository();
    const malformed = JSON.stringify({
      ...aggregate,
      transcriptCapture: {
        sequence: 2,
        items: [
          {
            itemId: "item_duplicate",
            firstSeenSequence: 1,
            role: "participant",
            text: "First projection",
            finalSequence: 1,
          },
          {
            itemId: "item_duplicate",
            firstSeenSequence: 1,
            role: "participant",
            text: "Second projection",
            finalSequence: 2,
          },
        ],
      },
      transcriptRevision: 1,
      transcriptDigest: `sha256:${"a".repeat(64)}`,
      nextEffectSequence: 2,
      state: {
        ...aggregate.state,
        effects: [
          {
            id: "run_repository:1",
            kind: "compute_transcript_digest",
            status: "dispatched",
            acceptance: "unobserved",
            attemptCount: 1,
            revision: 1,
          },
        ],
      },
    });
    durable.storage.sql.exec(
      "UPDATE runtime_controller_state SET finalization_state_json = ? WHERE run_id = ?",
      malformed,
      "run_repository",
    );

    const repository = repositoryFor(durable);
    repository.initialize();

    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
  });

  it("rejects a terminal row without a current aggregate", () => {
    const { durable } = setupRepository();
    durable.storage.sql.exec(
      `UPDATE runtime_controller_state
       SET phase = 'ended', completion_json = ?, callback_pending = 1
       WHERE run_id = ?`,
      JSON.stringify({ runId: "run_repository", outcome: "ended" }),
      "run_repository",
    );
    const repository = repositoryFor(durable);
    repository.initialize();
    expect(() => repository.readState()).toThrow("invalid_finalization_state");
    expect(events(durable)).toContain("runtime.invalid_finalization_state");
  });
});

function setupLiveRepository() {
  const setup = setupRepository();
  const aggregate: InterviewFinalizationAggregate = {
    ...liveFinalizationAggregate({ runId: "run_repository" }),
    conversationNodeExecution: {
      kind: "ordinary",
      mediaCutoffAt: 1_700_000_061_000,
      timers: [
        {
          id: "test-duration",
          deadlineAt: 1_700_000_061_000,
          event: { kind: "interview_time_elapsed" },
        },
      ],
      associatedTimerId: "test-duration",
    },
  };
  setup.repository.commitSetupToLive({
    runId: "run_repository",
    liveEvidenceAt: 1_700_000_001_000,
    transitionAt: 1_700_000_001_000,
    deadlineAt: 1_700_000_061_000,
    presenceGraceUntil: 1_700_000_016_000,
    aggregate,
  });
  return { ...setup, aggregate };
}

function endedAggregate(aggregate: InterviewFinalizationAggregate): InterviewFinalizationAggregate {
  const ending = advanceInterviewFinalization(aggregate, {
    kind: "end_requested",
    reason: "participant_stopped",
    source: "browser_request",
    at: 1_700_000_000_100,
  });
  const drainingSettled = settlePendingEffects(ending.aggregate, 1_700_000_000_100);
  const closing = advanceInterviewFinalization(drainingSettled, {
    kind: "deadline_reached",
    deadline: "drain",
    at: 1_700_000_006_100,
  });
  const closingSettled = settlePendingEffects(closing.aggregate, 1_700_000_006_100);
  const finalizing = advanceInterviewFinalization(closingSettled, {
    kind: "deadline_reached",
    deadline: "finalization_cutoff",
    at: 1_700_000_010_100,
  });
  return advanceInterviewFinalization(finalizing.aggregate, {
    kind: "transcript_digest_computed",
    revision: finalizing.aggregate.transcriptRevision,
    digest: `sha256:${"a".repeat(64)}`,
    at: 1_700_000_010_100,
  }).aggregate;
}

function settlePendingEffects(
  aggregate: InterviewFinalizationAggregate,
  at: number,
): InterviewFinalizationAggregate {
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

const repositorySetup = {
  runId: "run_repository",
  runtimeId: "runtime_repository",
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_000,
  fakeSessionId: null,
  deliveryTarget: { integration: "test", context: { runId: "run_repository" } },
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
} satisfies Parameters<InterviewFinalizationRepository["createSetup"]>[0];

function setupRepository() {
  const durable = createTestDurableObjectContext();
  openDatabases.push(durable);
  const repository = repositoryFor(durable);
  repository.initialize();
  repository.createSetup(repositorySetup);
  return { durable, repository };
}

function repositoryFor(
  durable: ReturnType<typeof createTestDurableObjectContext>,
  crashInjector?: (point: AggregatePersistenceCrashPoint) => void,
): InterviewFinalizationRepository {
  return new InterviewFinalizationRepository(
    createDurableObjectState(durable.ctx).storage,
    crashInjector,
  );
}

function events(durable: ReturnType<typeof createTestDurableObjectContext>): string[] {
  return durable.storage.sql
    .exec<{ event_name: string }>(
      "SELECT event_name FROM runtime_controller_events ORDER BY id ASC",
    )
    .toArray()
    .map((row) => row.event_name);
}

function aggregateWrites(
  durable: ReturnType<typeof createTestDurableObjectContext>,
  afterExecution: number,
): boolean[] {
  return durable.storage.sql.executions
    .slice(afterExecution)
    .filter((execution) => execution.sql.includes("SET phase = ?, deadline_at = ?"))
    .map((execution) => execution.inTransaction);
}
