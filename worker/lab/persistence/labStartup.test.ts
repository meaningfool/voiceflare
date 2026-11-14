import { originalRealtimeSelection } from "../../shared/contracts/conversationSelection.ts";
import { applicationCallbackUrl } from "../../runtime/applicationCallbacks.ts";
import { createInterviewConversationInput } from "../../../src/apps/lab/data/conversationPresets.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLabD1Database, type TestD1DatabaseHandle } from "../../shared/testing/d1.ts";
import { createLabRun, getLabRun, persistLabRunTranscriptSnapshot } from "./labD1.ts";
import {
  getLabStartupState,
  recordLabRuntimeDispatchIntent,
  resolveOverdueLabStartup,
} from "./labStartup.ts";
import {
  handleLabRuntimeControllerReadiness,
  handleLabRuntimeControllerCompletion,
  handleLabRunStart,
} from "../routes/labRuntime.ts";
import { getLabTerminalResult } from "./labTerminalResults.ts";
import { processLabStartupWork } from "../labStartupDeadline.ts";
import { createRuntimeTranscriptSnapshot } from "../../shared/runtimeTranscriptSnapshot.ts";
import type { RuntimeTerminalResult } from "../../shared/contracts/runtimeTerminalResult.ts";
import { runtimeBindingWithCatalogCheck } from "../../runtime/testing/runtimeWorkerBinding.ts";

let database: TestD1DatabaseHandle;
beforeEach(() => {
  database = createTestLabD1Database();
});
afterEach(() => database.close());
const callback = (payload: RuntimeTerminalResult | Readonly<{ runId: string; liveAt: number }>) =>
  new Request(applicationCallbackUrl("completion"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

describe("Lab authoritative startup and canonical result receipts", () => {
  it("retains committed success across a lost readiness reply and the original expiry", async () => {
    const run = await createLabRun(database.d1);
    await recordLabRuntimeDispatchIntent(database.d1, run.runId, run.startedAt);
    await handleLabRuntimeControllerReadiness(
      callback({ runId: run.runId, liveAt: run.startedAt + 1 }),
      { LAB_DB: database.d1 },
    );
    const recovered = await resolveOverdueLabStartup(
      database.d1,
      run.runId,
      run.startedAt + 30_001,
    );
    expect(recovered).toMatchObject({
      status: "succeeded",
      expiresAt: run.startedAt + 30_000,
      reason: "readiness_confirmed",
      stopRequired: false,
    });
    const repeated = await handleLabRuntimeControllerReadiness(
      callback({ runId: run.runId, liveAt: run.startedAt + 1 }),
      { LAB_DB: database.d1 },
    );
    expect(await repeated.json()).toMatchObject({
      runId: run.runId,
      disposition: "succeeded",
      stopRequired: false,
    });
  });

  it("expires startup finally and recovers required-stop when the first reply is lost", async () => {
    const run = await createLabRun(database.d1);
    await recordLabRuntimeDispatchIntent(database.d1, run.runId, run.startedAt);
    const received: unknown[] = [];
    let acknowledge = false;
    const env = {
      LAB_DB: database.d1,
      RUNTIME_WORKER: {
        fetch: async (request: Request) => {
          received.push(await request.json());
          if (!acknowledge) throw new Error("reply_lost");
          return Response.json({ runId: run.runId, accepted: true, acceptance: "accepted" });
        },
      },
    };
    const failed = await processLabStartupWork(env, run.runId, run.startedAt + 30_000);
    expect(failed).toMatchObject({
      status: "failed",
      reason: "deadline_expired",
      expiresAt: run.startedAt + 30_000,
      stopRequired: true,
      stopAcknowledgedAt: null,
      stopAttemptCount: 1,
    });
    const late = await handleLabRuntimeControllerReadiness(
      callback({ runId: run.runId, liveAt: run.startedAt + 1 }),
      env,
    );
    expect(await late.json()).toMatchObject({ disposition: "failed", stopRequired: true });
    acknowledge = true;
    const recovered = await processLabStartupWork(env, run.runId, run.startedAt + 40_000);
    expect(recovered?.stopAcknowledgedAt).toEqual(expect.any(Number));
    // Runtime accepted this Run and it went live, so its result stays Runtime's to publish.
    expect(await getLabTerminalResult(database.d1, run.runId)).toBeNull();
    expect(received).toEqual([
      { runId: run.runId, reason: "application_startup_failed" },
      { runId: run.runId, reason: "application_startup_failed" },
    ]);
  });

  it("keeps a not-accepted stop until its failed start is recorded", async () => {
    const run = await createLabRun(database.d1);
    await recordLabRuntimeDispatchIntent(database.d1, run.runId, run.startedAt);
    const runtime = {
      fetch: async () =>
        Response.json({ runId: run.runId, accepted: true, acceptance: "not_accepted" }),
    };
    const failingResultWrite: typeof database.d1 = {
      prepare(sql) {
        if (sql.includes("SET terminal_result_json")) throw new Error("result_write_failed");
        return database.d1.prepare(sql);
      },
    };
    const failed = await processLabStartupWork(
      { LAB_DB: failingResultWrite, RUNTIME_WORKER: runtime },
      run.runId,
      run.startedAt + 30_000,
    );
    expect(failed).toMatchObject({ status: "failed", stopAcknowledgedAt: null });
    expect(await getLabTerminalResult(database.d1, run.runId)).toBeNull();

    const recovered = await processLabStartupWork(
      { LAB_DB: database.d1, RUNTIME_WORKER: runtime },
      run.runId,
      run.startedAt + 40_000,
    );
    expect(recovered?.stopAcknowledgedAt).toEqual(expect.any(Number));
    expect(await getLabTerminalResult(database.d1, run.runId)).toMatchObject({
      runId: run.runId,
      outcome: "failed_to_start",
      runtimeUsage: { completeness: "complete", observations: [] },
    });
  });

  it("pairs truthful post-Live evidence after failed startup and seals usage without requiring completeness", async () => {
    const run = await createLabRun(database.d1);
    await recordLabRuntimeDispatchIntent(database.d1, run.runId, run.startedAt);
    await resolveOverdueLabStartup(database.d1, run.runId, run.startedAt + 30_000);
    const snapshot = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "participant", text: "Feedback" }],
    });
    await persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot });
    const result: RuntimeTerminalResult = {
      runId: run.runId,
      outcome: "interrupted",
      liveAt: run.startedAt + 1,
      endedAt: run.startedAt + 30_001,
      transcriptSnapshot: {
        revision: snapshot.revision,
        digest: snapshot.digest,
        turnCount: snapshot.turnCount,
      },
      transcriptCompleteness: "incomplete",
      transcriptIncompleteReasons: [{ kind: "conversation_evidence_gap" }],
      runtimeUsage: {
        completeness: "incomplete",
        observations: [
          {
            componentRole: "speech_to_speech",
            provider: "openai",
            model: "lab-model-override",
            measure: "output_audio",
            unit: "token",
            quantity: 12,
          },
        ],
      },
    };
    const env = { LAB_DB: database.d1 };
    expect(
      await (await handleLabRuntimeControllerCompletion(callback(result), env)).json(),
    ).toMatchObject({ status: "completed" });
    expect(
      await (await handleLabRuntimeControllerCompletion(callback(result), env)).json(),
    ).toMatchObject({ status: "idempotent" });
    expect(await getLabTerminalResult(database.d1, run.runId)).toEqual(result);
    expect((await getLabRun(database.d1, run.runId))?.transcript).toEqual(snapshot.transcript);
    expect((await getLabStartupState(database.d1, run.runId))?.status).toBe("failed");
    const changed: RuntimeTerminalResult = {
      ...result,
      runtimeUsage: { completeness: "complete", observations: [] },
    };
    expect((await handleLabRuntimeControllerCompletion(callback(changed), env)).status).toBe(409);
    const later = await createRuntimeTranscriptSnapshot(2, { turns: [] });
    expect(
      await persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot: later }),
    ).toMatchObject({ status: "sealed" });
  });

  it("fails pending startup from terminal evidence before its matching Transcript arrives", async () => {
    const run = await createLabRun(database.d1);
    await recordLabRuntimeDispatchIntent(database.d1, run.runId, run.startedAt);
    const snapshot = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "participant", text: "Feedback" }],
    });
    const result: RuntimeTerminalResult = {
      runId: run.runId,
      outcome: "interrupted",
      liveAt: run.startedAt + 1,
      endedAt: run.startedAt + 2,
      transcriptSnapshot: {
        revision: snapshot.revision,
        digest: snapshot.digest,
        turnCount: snapshot.turnCount,
      },
      transcriptCompleteness: "incomplete",
      transcriptIncompleteReasons: [{ kind: "conversation_evidence_gap" }],
      runtimeUsage: { completeness: "incomplete", observations: [] },
    };
    const env = { LAB_DB: database.d1 };
    expect((await handleLabRuntimeControllerCompletion(callback(result), env)).status).toBe(503);
    expect(await getLabStartupState(database.d1, run.runId)).toMatchObject({
      status: "failed",
      reason: "terminal_result_received",
      stopRequired: true,
    });
    expect(await getLabTerminalResult(database.d1, run.runId)).toBeNull();
    expect(
      await (
        await handleLabRuntimeControllerReadiness(
          callback({ runId: run.runId, liveAt: result.liveAt }),
          env,
        )
      ).json(),
    ).toMatchObject({ disposition: "failed" });
    expect(
      await persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot }),
    ).toMatchObject({ status: "stored" });
    expect((await handleLabRuntimeControllerCompletion(callback(result), env)).status).toBe(200);
    expect(await getLabTerminalResult(database.d1, run.runId)).toEqual(result);
  });

  it("keeps dispatched Start failure separate from late truthful execution evidence", async () => {
    const env = {
      LAB_DB: database.d1,
      LAB_STARTUP_DEADLINE: {
        getByName: (_name: string) => ({
          arm: async (_runId: string, _expiry: number) => {},
          wake: async (_runId: string) => {},
        }),
      },
      RUNTIME_WORKER: runtimeBindingWithCatalogCheck(async () =>
        Response.json({ error: "connection_reply_failed" }, { status: 500 }),
      ),
    };
    const start = await handleLabRunStart(
      new Request("https://lab.test/_api/runtime/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selection: originalRealtimeSelection,
          profile: "realtime-v1",
          connection: { exchangeId: "initial", input: { sdp: "v=0" } },
          agentInput: createInterviewConversationInput("Lab prompt"),
        }),
      }),
      env,
    );
    expect(start.status).toBe(500);
    const runId = start.headers.get("X-Lab-Run-Id");
    if (runId === null) throw new Error("missing_lab_run_id");
    expect(await getLabStartupState(database.d1, runId)).toMatchObject({
      status: "failed",
      stopRequired: true,
    });
    expect(await getLabRun(database.d1, runId)).not.toHaveProperty("endedAt");
    const snapshot = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "participant", text: "Feedback" }],
    });
    expect(await persistLabRunTranscriptSnapshot(database.d1, { runId, snapshot })).toMatchObject({
      status: "stored",
    });
  });

  it("receives a failed-to-start result with no invented Live or Transcript evidence", async () => {
    const run = await createLabRun(database.d1);
    const result: RuntimeTerminalResult = {
      runId: run.runId,
      outcome: "failed_to_start",
      endedAt: run.startedAt + 1,
      runtimeUsage: { completeness: "incomplete", observations: [] },
    };
    const env = { LAB_DB: database.d1 };
    expect((await handleLabRuntimeControllerCompletion(callback(result), env)).status).toBe(200);
    expect(await getLabTerminalResult(database.d1, run.runId)).toEqual(result);
    expect((await getLabStartupState(database.d1, run.runId))?.status).toBe("failed");
  });
});
