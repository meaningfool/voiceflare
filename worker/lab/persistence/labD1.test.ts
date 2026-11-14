import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendRuntimeEvents,
  appendLabRuntimeDiagnosticRecords,
  completeLabRunFromSnapshot,
  createLabRun,
  getLabRun,
  getLabStartRequest,
  getRunDiagnostics,
  listRuntimeEvents,
  listLabRuns,
  recordCompletionDiagnostics,
  persistLabRunTranscriptSnapshot,
  recordProviderCall,
  recordSettingsSummary,
  recordLabRunSetupFailureEnd,
  recordSetupFailure,
} from "./labD1.ts";
import type { RuntimeCompletion } from "../../shared/runtimeControllerCallback.ts";
import { createRuntimeTranscriptSnapshot } from "../../shared/runtimeTranscriptSnapshot.ts";
import { createTestLabD1Database, type TestD1DatabaseHandle } from "../../shared/testing/d1.ts";
import type {
  D1DatabaseCapability,
  D1PreparedStatementCapability,
} from "../../shared/persistence/runDiagnosticsD1.ts";

let database: TestD1DatabaseHandle;

beforeEach(() => {
  database = createTestLabD1Database();
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

function interleaveAfterSnapshotWrite(
  db: D1DatabaseCapability,
  interleave: () => Promise<void>,
): D1DatabaseCapability {
  let snapshotWriteCompleted = false;
  let interleaved = false;

  const wrap = (
    statement: D1PreparedStatementCapability,
    query: string,
  ): D1PreparedStatementCapability => ({
    bind: (...values) => wrap(statement.bind(...values), query),
    run: async () => {
      const result = await statement.run();
      if (query.includes("SET transcript_json = ?") && query.includes("transcript_revision = ?")) {
        snapshotWriteCompleted = true;
      }
      return result;
    },
    all: () => statement.all(),
    first: async () => {
      if (
        snapshotWriteCompleted &&
        !interleaved &&
        query.includes("SELECT") &&
        query.includes("transcript_revision")
      ) {
        interleaved = true;
        await interleave();
      }
      return statement.first();
    },
  });

  return {
    prepare: (query) => wrap(db.prepare(query), query),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

describe("Lab D1 persistence", () => {
  it("rejects corrupted retained Start timing rather than renewing the deadline", async () => {
    const startAttempt = { attemptId: "2e949a49-15d5-49c3-8d82-5e7fc0f71fb5", requestJson: "{}" };
    const run = await createLabRun(database.d1, { startAttempt });
    await database.d1
      .prepare("UPDATE lab_runs SET started_at = 'unchecked' WHERE run_id = ?")
      .bind(run.runId)
      .run();
    await expect(createLabRun(database.d1, { startAttempt })).rejects.toThrow();
  });

  it("reads a saved Start request only when it carries the admitted selection and inputs", async () => {
    const selection = {
      conversation: { id: "original-interview", version: 1 },
      execution: { id: "realtime", version: 1 },
    };
    const saved = {
      profile: "realtime-v1",
      connection: { exchangeId: "start", input: { sdp: "private-offer" } },
      selection,
      agentInput: { contract: "original-interview-input/v1" },
    };
    const readSaved = async (attemptId: string, requestJson: string) => {
      const run = await createLabRun(database.d1, {
        startAttempt: { attemptId, requestJson },
      });
      return getLabStartRequest(database.d1, run.runId);
    };
    await expect(
      readSaved("2e949a49-15d5-49c3-8d82-5e7fc0f71fb1", JSON.stringify(saved)),
    ).resolves.toEqual({
      profile: "realtime-v1",
      selection,
      agentInput: { contract: "original-interview-input/v1" },
    });
    const { selection: _selection, ...missingSelection } = saved;
    for (const [index, invalid] of [
      missingSelection,
      { ...saved, profile: 42 },
      { ...saved, selection: { ...selection, execution: { id: "realtime", version: "1" } } },
    ].entries())
      await expect(
        readSaved(`2e949a49-15d5-49c3-8d82-5e7fc0f71fc${String(index)}`, JSON.stringify(invalid)),
      ).rejects.toThrow();
    const unsaved = await createLabRun(database.d1);
    await expect(getLabStartRequest(database.d1, unsaved.runId)).resolves.toBeNull();
    await expect(getLabStartRequest(database.d1, "lab_missing")).resolves.toBeNull();
  });

  it("retains selected model, output cap, and per-response output usage on run review", async () => {
    const run = await createLabRun(database.d1, { now: () => 1_700_000_000_000 });
    await recordSettingsSummary(database.d1, {
      runId: run.runId,
      settingsSummary: { model: "gpt-realtime-2.1", maxOutputTokens: 1024 },
    });
    const snapshot = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "conversationAgent", text: "What surprised you?" }],
    });
    await persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot });
    const event = {
      type: "realtime.provider_event_observed",
      payloadJson: JSON.stringify({
        providerEventType: "response.done",
        responseId: "resp_1",
        response: { outputTokens: 812, output: [{ type: "message", role: "assistant" }] },
      }),
    };
    const trusted = {
      ...event,
      recordId: `${run.runId}:1`,
      runId: run.runId,
      source: "execution" as const,
      selection: null,
      visitId: null,
      operationId: null,
      observedAt: Date.now(),
      sequence: 1,
      elapsedMs: 0,
    };
    await appendLabRuntimeDiagnosticRecords(database.d1, run.runId, [trusted, trusted]);
    const detail = await getLabRun(database.d1, run.runId);
    expect(detail).toMatchObject({
      executionModel: "gpt-realtime-2.1",
      maxOutputTokens: 1024,
      responseUsage: [
        { responseId: "resp_1", outputTokens: 812, model: "gpt-realtime-2.1", answerTurnNumber: 1 },
      ],
    });
    await database.d1.prepare("DELETE FROM runtime_events WHERE run_id = ?").bind(run.runId).run();
    expect((await getLabRun(database.d1, run.runId))?.responseUsage).toEqual(detail?.responseUsage);
    await appendRuntimeEvents(database.d1, {
      runId: run.runId,
      records: [
        {
          type: "realtime.provider_event_observed",
          payloadJson: JSON.stringify({
            providerEventType: "response.done",
            responseId: "resp_tool",
            response: { output: [{ type: "function_call" }] },
          }),
        },
      ],
    });
    expect((await getLabRun(database.d1, run.runId))?.responseUsage).toEqual([
      { responseId: "resp_1", outputTokens: 812, model: "gpt-realtime-2.1", answerTurnNumber: 1 },
    ]);
  });
  it("fills the per-response output usage from Cascade's model usage records", async () => {
    const run = await createLabRun(database.d1, { now: () => 1_700_000_000_000 });
    await recordSettingsSummary(database.d1, {
      runId: run.runId,
      settingsSummary: { model: "cascade-v1/original-interview", maxOutputTokens: "inf" },
    });
    const record = (sequence: number, type: string, payloadJson: string) => ({
      type,
      payloadJson,
      recordId: `${run.runId}:${String(sequence)}`,
      runId: run.runId,
      source: "execution" as const,
      selection: null,
      visitId: null,
      operationId: null,
      observedAt: Date.now(),
      sequence,
      elapsedMs: 0,
    });
    const usage = {
      source: "runtime_controller",
      provider: "cascade",
      model: "gpt-5.4-mini-2026-03-17",
      inputTokens: 120,
    };
    const modelUsage = (outputId: string, outputTokens: number) =>
      JSON.stringify({ ...usage, outputId, outputTokens });
    await appendLabRuntimeDiagnosticRecords(database.d1, run.runId, [
      record(1, "cascade.model_usage", modelUsage("cascade_output_1", 14)),
      record(
        2,
        "cascade.speech_output_usage",
        JSON.stringify({ outputId: "cascade_output_1", characters: 40 }),
      ),
      record(3, "cascade.model_usage", modelUsage("cascade_output_2", 9)),
      record(4, "cascade.model_usage", modelUsage("", 3)),
      record(5, "cascade.model_usage", modelUsage("cascade_output_3", -1)),
    ]);
    expect((await getLabRun(database.d1, run.runId))?.responseUsage).toEqual([
      { responseId: "cascade_output_1", outputTokens: 14, model: "cascade-v1/original-interview" },
      { responseId: "cascade_output_2", outputTokens: 9, model: "cascade-v1/original-interview" },
    ]);
  });

  it("keeps setup-failure persistence out of current transcript state", async () => {
    const run = await createLabRun(database.d1, { now: () => 1_700_000_000_000 });
    const snapshot = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "participant", text: "The Runtime is already active." }],
    });
    await persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot });

    await expect(
      recordLabRunSetupFailureEnd(database.d1, {
        runId: run.runId,
        endedAt: 1_700_000_030_000,
      }),
    ).resolves.toBe(false);
    expect((await getLabRun(database.d1, run.runId))?.endedAt).toBeUndefined();
  });

  it("rejects a conflicting sealed Runtime completion when only its source changes", async () => {
    const run = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });
    const snapshot = await createRuntimeTranscriptSnapshot(0, { turns: [] });
    await persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot });
    const completion = {
      runId: run.runId,
      outcome: "ended",
      endReason: "participant_stopped",
      source: "browser_request",
      endingStartedAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      finalizedAt: 1_700_000_001_100,
      transcriptSnapshot: {
        revision: snapshot.revision,
        digest: snapshot.digest,
        turnCount: snapshot.turnCount,
      },
      warnings: [],
    } satisfies RuntimeCompletion;

    await expect(completeLabRunFromSnapshot(database.d1, { completion })).resolves.toMatchObject({
      status: "completed",
    });
    await expect(completeLabRunFromSnapshot(database.d1, { completion })).resolves.toMatchObject({
      status: "idempotent",
    });
    await expect(
      completeLabRunFromSnapshot(database.d1, {
        completion: { ...completion, source: "controller_alarm" },
      }),
    ).resolves.toMatchObject({ status: "completion_conflict" });
  });

  it("reports the actual Lab snapshot winner when a higher revision races the receipt", async () => {
    const run = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });
    const first = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "participant", text: "First." }],
    });
    const second = await createRuntimeTranscriptSnapshot(2, {
      turns: [
        { role: "participant", text: "First." },
        { role: "conversationAgent", text: "Second." },
      ],
    });
    const racingDb = interleaveAfterSnapshotWrite(database.d1, async () => {
      await persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot: second });
    });

    await expect(
      persistLabRunTranscriptSnapshot(racingDb, { runId: run.runId, snapshot: first }),
    ).resolves.toMatchObject({
      status: "stale",
      storedSnapshot: {
        revision: second.revision,
        digest: second.digest,
        turnCount: second.turnCount,
      },
      requestedMatches: false,
    });
  });

  it("creates shared diagnostics storage without Lab-owned foreign keys", async () => {
    await expect(
      database.d1
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_events'")
        .first(),
    ).resolves.toEqual({
      name: "runtime_events",
    });
    await expect(
      database.d1
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_diagnostic_summaries'",
        )
        .first(),
    ).resolves.toEqual({
      name: "run_diagnostic_summaries",
    });
    await expect(
      database.d1.prepare("PRAGMA foreign_key_list(run_diagnostic_summaries)").all(),
    ).resolves.toMatchObject({
      results: [],
    });
    await expect(
      database.d1.prepare("PRAGMA foreign_key_list(runtime_events)").all(),
    ).resolves.toMatchObject({
      results: [],
    });
    await expect(
      database.d1
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_diagnostics'",
        )
        .first(),
    ).resolves.toBeNull();
    await expect(
      database.d1
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_evidence'",
        )
        .first(),
    ).resolves.toBeNull();
  });

  it("creates, lists, opens, updates, and ends Lab Runs", async () => {
    const promptProvenance = {
      promptId: "sample-prompt",
      promptFileName: "sample-prompt.md",
      contentHash: "fnv1a64:1234",
    };

    await expect(
      createLabRun(database.d1, {
        promptProvenance,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toEqual({
      runId: "lab_00000000-0000-4000-8000-000000000001",
      startedAt: 1_700_000_000_000,
    });

    const snapshot = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "participant", text: "It worked." }],
    });
    await expect(
      persistLabRunTranscriptSnapshot(database.d1, {
        runId: "lab_00000000-0000-4000-8000-000000000001",
        snapshot,
      }),
    ).resolves.toMatchObject({ status: "stored" });
    await expect(
      completeLabRunFromSnapshot(database.d1, {
        completion: {
          runId: "lab_00000000-0000-4000-8000-000000000001",
          outcome: "ended",
          endReason: "participant_stopped",
          source: "test_fixture",
          endingStartedAt: 1_700_000_030_000,
          endedAt: 1_700_000_030_000,
          finalizedAt: 1_700_000_030_000,
          transcriptSnapshot: {
            revision: snapshot.revision,
            digest: snapshot.digest,
            turnCount: snapshot.turnCount,
          },
          warnings: [],
        },
      }),
    ).resolves.toMatchObject({ status: "completed" });

    await expect(listLabRuns(database.d1)).resolves.toEqual([
      {
        runId: "lab_00000000-0000-4000-8000-000000000001",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_030_000,
        outcome: "ended",
        endReason: "participant_stopped",
        transcriptTurnCount: 1,
      },
    ]);
    await expect(
      getLabRun(database.d1, "lab_00000000-0000-4000-8000-000000000001"),
    ).resolves.toEqual({
      runId: "lab_00000000-0000-4000-8000-000000000001",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_030_000,
      outcome: "ended",
      endReason: "participant_stopped",
      transcriptTurnCount: 1,
      responseUsage: [],
      transcript: {
        turns: [
          {
            role: "participant",
            text: "It worked.",
          },
        ],
      },
    });
  });

  it("preserves historical ended Lab Runs without an end reason", async () => {
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });

    await database.d1
      .prepare("UPDATE lab_runs SET ended_at = ?, outcome = ? WHERE run_id = ?")
      .bind(1_700_000_030_000, "ended", created.runId)
      .run();

    await expect(listLabRuns(database.d1)).resolves.toEqual([
      {
        runId: created.runId,
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_030_000,
        outcome: "ended",
        transcriptTurnCount: 0,
      },
    ]);
    await expect(getLabRun(database.d1, created.runId)).resolves.toEqual({
      runId: created.runId,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_030_000,
      outcome: "ended",
      transcriptTurnCount: 0,
      responseUsage: [],
      transcript: {
        turns: [],
      },
    });
  });

  it("preserves malformed-row failures at each Lab persistence ingress", async () => {
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });

    await database.d1
      .prepare("UPDATE lab_runs SET started_at = ? WHERE run_id = ?")
      .bind("invalid", created.runId)
      .run();

    await expect(getLabRun(database.d1, created.runId)).rejects.toThrow("invalid_lab_run_row");
    await expect(getRunDiagnostics(database.d1, created.runId)).rejects.toThrow(
      "invalid_lab_run_row",
    );

    await database.d1
      .prepare("UPDATE lab_runs SET started_at = ?, max_output_tokens = ? WHERE run_id = ?")
      .bind(1_700_000_000_000, "unlimited", created.runId)
      .run();
    await expect(getLabRun(database.d1, created.runId)).rejects.toThrow("invalid_lab_run_row");

    await database.d1
      .prepare(
        "UPDATE lab_runs SET max_output_tokens = NULL, transcript_digest = ? WHERE run_id = ?",
      )
      .bind("invalid", created.runId)
      .run();
    const snapshot = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "participant", text: "Still owned by the Runtime." }],
    });

    await expect(
      persistLabRunTranscriptSnapshot(database.d1, { runId: created.runId, snapshot }),
    ).rejects.toThrow("invalid_lab_transcript_identity");
  });

  it("keeps runtime diagnostics separate from normal Lab Run review projections", async () => {
    const created = await createLabRun(database.d1, {
      promptProvenance: {
        promptId: "sample-prompt",
        promptFileName: "sample-prompt.md",
        contentHash: "fnv1a64:1234",
      },
      now: () => 1_700_000_000_000,
    });

    await recordProviderCall(database.d1, {
      runId: created.runId,
      sessionId: "rtc_provider_call",
    });
    await recordSetupFailure(database.d1, {
      runId: created.runId,
      errorText: "Provider/signaling failed.",
      failureKind: "provider_signaling",
      source: "lab_worker",
    });
    await recordSettingsSummary(database.d1, {
      runId: created.runId,
      settingsSummary: {
        model: "gpt-realtime-2",
        voice: "marin",
      },
    });
    await recordCompletionDiagnostics(database.d1, {
      runId: created.runId,
      completionStatus: "sidebandClosed",
      completionReviewStatus: "clean",
      completionDebugText: "Final Transcript persistence observed with 2 turns.",
    });

    await expect(getLabRun(database.d1, created.runId)).resolves.not.toHaveProperty("sessionId");
    const normalReview = JSON.stringify(await getLabRun(database.d1, created.runId));
    for (const secret of [
      "rtc_provider_call",
      "Provider/signaling failed.",
      "sample-prompt",
      "Final Transcript persistence",
    ])
      expect(normalReview).not.toContain(secret);
    await expect(getRunDiagnostics(database.d1, created.runId)).resolves.toMatchObject({
      sessionId: "rtc_provider_call",
      completionStatus: "sidebandClosed",
    });
  });

  it("sanitizes shared Runtime Event payloads at the recorder boundary", async () => {
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });

    await appendRuntimeEvents(database.d1, {
      runId: created.runId,
      records: [
        {
          observedAt: 1_700_000_000_000,
          sequence: 1,
          elapsedMs: 120,
          type: "realtime.provider_event_observed",
          payload: {
            source: "provider",
            providerEventType: "response.done",
            sdp: "v=0",
            headers: {
              Authorization: "Bearer sk-test-secret",
            },
            publicLinkToken: "secret-public-link-token",
            prompt: "Prompt text must not be diagnostics.",
            transcript: {
              turns: [
                {
                  role: "participant",
                  text: "Transcript text must not be diagnostics.",
                },
              ],
            },
            nested: {
              safe: "kept",
              stack: "stack trace",
              apiKey: "sk-test-secret",
            },
          },
        },
      ],
    });

    const [event] = await listRuntimeEvents(database.d1, created.runId);

    if (event === undefined) {
      throw new Error("expected_runtime_event");
    }

    const payloadJson = event.payloadJson;

    expect(JSON.parse(payloadJson)).toEqual({
      source: "provider",
      providerEventType: "response.done",
      nested: {
        safe: "kept",
        apiKey: "sk-redacted",
      },
    });
  });
});
