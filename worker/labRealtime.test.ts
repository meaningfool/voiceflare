import { originalRealtimeSelection } from "./shared/contracts/conversationSelection.ts";
import {
  createQuestionsConversationInput,
  createInterviewConversationInput,
  createGoodbyeConversationInput,
} from "../src/apps/lab/data/conversationPresets.ts";
import {
  questionPromptPresets,
  nextQuestionDescription,
  goodbyeFinishDescription,
  defaultClosingSentence,
  defaultFinishInterviewDescription,
  goodbyeInterviewInstructions,
} from "../src/apps/lab/content/presets.ts";
import { getLabStartupState } from "./lab/persistence/labStartup.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { labWorkerTestHarness as labWorker } from "./lab.ts";
import { runtimeBindingWithCatalogCheck } from "./runtime/testing/runtimeWorkerBinding.ts";
import {
  decodeLabConnectionStart,
  handleLabRuntimeControllerTranscript,
} from "./lab/routes/labRuntime.ts";
import { applicationCallbackUrl } from "./runtime/applicationCallbacks.ts";
import {
  appendRuntimeEvents,
  createLabRun,
  getLabRun,
  getRunDiagnostics,
  listLabRuns,
  listRuntimeEvents,
} from "./lab/persistence/labD1.ts";
import { SETTINGS_SUMMARY_HEADER } from "./shared/runtimeHeaders.ts";
import { runDiagnosticEventRetentionMs } from "./shared/persistence/runDiagnosticsD1.ts";
import { FINISH_INTERVIEW_TOOL_NAME } from "./implementations/originalRealtime/implementation.ts";
import {
  prepareRealtimeSettings,
  summarizePreparedModelSession,
} from "./providers/openaiRealtime/preparedModelSession.ts";
import { createTestLabD1Database } from "./shared/testing/d1.ts";
import { decodeLabCascadeProviderOptions } from "../src/apps/lab/data/cascadeProviderOptions.ts";
import {
  labCascadeNumberChoices,
  type LabCascadeExecutionSettings,
} from "../src/apps/lab/cascadeClient/labCascadeSettings.ts";
import {
  cascadeDefaultProviderSettings,
  cascadeExecutionSettingsSchema,
  cascadeProviderDeclarations,
} from "./providers/cascade/settings.ts";
import {
  cascadeCombination,
  prepareCascadeSettings,
  summarizeCascadeSettings,
} from "./providers/cascade/preparedSession.ts";
import { createRuntimeTranscriptSnapshot } from "./shared/runtimeTranscriptSnapshot.ts";

type LabStartFixture = {
  profile: string;
  connection: { exchangeId: string; input: { token: string } };
  selection: typeof originalRealtimeSelection;
  agentInput: ReturnType<typeof createInterviewConversationInput>;
};

const startupDeadline = {
  getByName: (_name: string) => ({
    arm: async (_runId: string, _expiresAt: number) => {},
    wake: async (_runId: string) => {},
  }),
};

const labUrl = "https://lab.example.test";
const rawExecution = (instructions = "Lab prompt") => ({
  agentInput: createInterviewConversationInput(instructions),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Lab connection start boundary", () => {
  const valid = {
    profile: "realtime-v1",
    connection: { exchangeId: "first", input: { token: "opaque" } },
    selection: originalRealtimeSelection,
    agentInput: createInterviewConversationInput("Ask why"),
  };

  it("returns the owned envelope with opaque connection input", () => {
    expect(decodeLabConnectionStart(valid)).toEqual(valid);
    const withAgentInput = { ...valid, agentInput: { finishInterviewDescription: 42 } };
    expect(decodeLabConnectionStart(withAgentInput)).toEqual(withAgentInput);
    expect(() =>
      decodeLabConnectionStart(
        Object.assign(Object.create({ agentInput: valid.agentInput }), {
          ...valid,
          agentInput: undefined,
        }),
      ),
    ).toThrow();
  });

  it.each([
    { ...valid, attemptId: 42 },
    { ...valid, attemptId: "not-a-uuid" },
    { ...valid, profile: undefined },
    { ...valid, profile: 42 },
    { ...valid, connection: { input: { token: "opaque" } } },
    { ...valid, connection: { exchangeId: 42 } },
    { ...valid, startupExpiresAt: 123 },
    { ...valid, maxDurationMs: 60_000 },
    { ...valid, extra: true },
    { ...valid, connection: { exchangeId: "first", extra: true } },
  ])("rejects missing, mistyped, malformed or unowned fields", (value) => {
    expect(() => decodeLabConnectionStart(value)).toThrow();
  });

  it.each(["profile", "selection", "agentInput", "connection"] as const)(
    "rejects inherited required %s",
    (field) => {
      const ownFields = { ...valid };
      Reflect.deleteProperty(ownFields, field);
      const value: unknown = Object.assign(Object.create({ [field]: valid[field] }), ownFields);
      expect(() => decodeLabConnectionStart(value)).toThrow();
    },
  );

  it("rejects an inherited required nested exchange identity", () => {
    const connection: unknown = Object.assign(Object.create({ exchangeId: "first" }), {
      input: { token: "opaque" },
    });
    expect(() => decodeLabConnectionStart({ ...valid, connection })).toThrow();
  });

  it("rejects inherited unknown fields rather than exposing them", () => {
    const value: unknown = Object.assign(Object.create({ extra: "excluded" }), valid);
    expect(() => decodeLabConnectionStart(value)).toThrow();
  });
});

describe("Lab Worker routes", () => {
  it("dispatches the exact Questions native configuration through the full Lab Start route", async () => {
    const database = createTestLabD1Database();
    const dispatched: unknown[] = [];
    const accepted = createQuestionsConversationInput(
      questionPromptPresets,
      nextQuestionDescription,
      goodbyeFinishDescription,
      defaultClosingSentence,
      180_000,
      45_000,
    );
    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attemptId: "93e17b77-97aa-4ae3-a0b3-c6fa19ae7a1c",
            profile: "realtime-v1",
            connection: { exchangeId: "questions-start", input: { sdp: "controlled-offer" } },
            selection: {
              conversation: { id: "questions-interview", version: 1 },
              execution: { id: "realtime", version: 1 },
            },
            agentInput: accepted,
            reasoningEffort: "low",
            executionSettings: {
              model: "gpt-realtime-2",
              voice: "marin",
              speed: 1,
              inputNoiseReduction: "far_field",
              semanticVadEagerness: "medium",
              maxOutputTokens: 700,
              truncation: "auto",
            },
          }),
        }),
        {
          LAB_DB: database.d1,
          LAB_STARTUP_DEADLINE: startupDeadline,
          RUNTIME_WORKER: runtimeBindingWithCatalogCheck(async (request) => {
            dispatched.push(await request.json());
            return new Response("controlled-answer", { status: 201 });
          }),
        },
      );
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 201,
        body: "controlled-answer",
      });
      expect(response.headers.get("X-Lab-Run-Id")).toBe("lab_93e17b77-97aa-4ae3-a0b3-c6fa19ae7a1c");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        selection: {
          conversation: { id: "questions-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
        execution: { agentInput: accepted },
        reasoningEffort: "low",
        executionSettings: { model: "gpt-realtime-2", voice: "marin" },
      });
      const saved = await labWorker.fetch(
        new Request(`${labUrl}/_api/runs/lab_93e17b77-97aa-4ae3-a0b3-c6fa19ae7a1c/start-request`),
        { LAB_DB: database.d1 },
      );
      // Verification evidence reads the admitted inputs back without the offer or attempt.
      expect({ status: saved.status, body: await saved.json() }).toEqual({
        status: 200,
        body: {
          profile: "realtime-v1",
          selection: {
            conversation: { id: "questions-interview", version: 1 },
            execution: { id: "realtime", version: 1 },
          },
          agentInput: accepted,
          reasoningEffort: "low",
          executionSettings: {
            model: "gpt-realtime-2",
            voice: "marin",
            speed: 1,
            inputNoiseReduction: "far_field",
            semanticVadEagerness: "medium",
            maxOutputTokens: 700,
            truncation: "auto",
          },
        },
      });
    } finally {
      database.close();
    }
  });
  it("retries the original Lab Start without replacing its experiment, offer or deadline", async () => {
    const database = createTestLabD1Database();
    const runtimeStarts: unknown[] = [];
    const runtime = runtimeBindingWithCatalogCheck(async (request) => {
      runtimeStarts.push(await request.json());
      return Response.json({ accepted: true });
    });
    const input = {
      attemptId: "2e949a49-15d5-49c3-8d82-5e7fc0f71fb5",
      profile: "realtime-v1",
      connection: { exchangeId: "retained", input: { sdp: "original-offer" } },
      selection: originalRealtimeSelection,
      agentInput: createInterviewConversationInput("Lab prompt"),
    };
    const start = (body: typeof input) =>
      labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        { LAB_DB: database.d1, LAB_STARTUP_DEADLINE: startupDeadline, RUNTIME_WORKER: runtime },
      );
    try {
      const first = await start(input);
      const second = await start(input);
      expect(first.headers.get("X-Lab-Run-Id")).toBe("lab_2e949a49-15d5-49c3-8d82-5e7fc0f71fb5");
      expect(second.headers.get("X-Lab-Run-Started-At")).toBe(
        first.headers.get("X-Lab-Run-Started-At"),
      );
      expect(runtimeStarts).toHaveLength(2);
      expect(runtimeStarts[1]).toEqual(runtimeStarts[0]);
      await expect(listLabRuns(database.d1)).resolves.toHaveLength(1);
      const conflict = await start({
        ...input,
        connection: { ...input.connection, input: { sdp: "replacement-offer" } },
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "lab_start_attempt_conflict" });
      expect(runtimeStarts).toHaveLength(2);
      await database.d1
        .prepare("UPDATE lab_runs SET startup_expires_at = 0 WHERE run_id = ?")
        .bind("lab_" + input.attemptId)
        .run();
      const expired = await start(input);
      expect(expired.status).toBe(409);
      expect(runtimeStarts).toHaveLength(2);
      await expect(listLabRuns(database.d1)).resolves.toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("retains an explicit failed experiment when deadline arming fails before Runtime dispatch", async () => {
    const database = createTestLabD1Database();
    const runtime = { fetch: vi.fn(async (_request: Request) => new Response("answer")) };
    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: "realtime-v1",
            connection: { exchangeId: "initial", input: { sdp: "v=0" } },
            selection: originalRealtimeSelection,
            agentInput: createInterviewConversationInput("Lab prompt"),
          }),
        }),
        {
          LAB_DB: database.d1,
          RUNTIME_WORKER: runtime,
          LAB_STARTUP_DEADLINE: {
            getByName: (_name: string) => ({
              arm: async (_runId: string, _expiresAt: number) => {
                throw new Error("alarm_unavailable");
              },
              wake: async (_runId: string) => {},
            }),
          },
        },
      );
      expect(response.status).toBe(503);
      const runId = response.headers.get("X-Lab-Run-Id");
      expect(runId).toEqual(expect.any(String));
      await expect(getLabStartupState(database.d1, runId ?? "missing")).resolves.toMatchObject({
        status: "failed",
        stopRequired: false,
        dispatchIntentAt: null,
      });
      expect(runtime.fetch).not.toHaveBeenCalled();
      await expect(getLabRun(database.d1, runId ?? "missing")).resolves.toMatchObject({
        terminalResult: {
          outcome: "failed_to_start",
          runtimeUsage: { completeness: "complete", observations: [] },
        },
      });
    } finally {
      database.close();
    }
  });

  it("bounds a lost initial Runtime reply at the original expiry and retains the allocated identity", async () => {
    vi.useFakeTimers();
    const receivedAt = Date.now();
    vi.setSystemTime(receivedAt);
    const database = createTestLabD1Database();
    const signals: AbortSignal[] = [];
    let observe = () => {};
    const observed = new Promise<void>((resolve) => {
      observe = resolve;
    });
    const received: string[] = [];
    const pending = labWorker.fetch(
      new Request(`${labUrl}/_api/runtime/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: "realtime-v1",
          connection: { exchangeId: "initial", input: { sdp: "v=0" } },
          selection: originalRealtimeSelection,
          agentInput: createInterviewConversationInput("Lab prompt"),
        }),
      }),
      {
        LAB_DB: database.d1,
        LAB_STARTUP_DEADLINE: startupDeadline,
        RUNTIME_WORKER: runtimeBindingWithCatalogCheck(async (request) => {
          signals.push(request.signal);
          observe();
          received.push(new URL(request.url).pathname);
          return new Promise<Response>(() => {});
        }),
      },
    );
    try {
      await observed;
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await pending;
      expect(response.status).toBe(503);
      const runId = requireResponseHeader(response, "X-Lab-Run-Id");
      expect(received).toEqual([`/_runtime/controllers/${runId}/connection`]);
      expect(signals[0]?.aborted).toBe(true);
      expect(await getLabRun(database.d1, runId)).toMatchObject({ runId, startedAt: receivedAt });
      expect(await getLabRun(database.d1, runId)).not.toHaveProperty("terminalResult");
    } finally {
      database.close();
    }
  });

  it("relays non-SDP connection input and opaque output while each initial start creates a Lab run", async () => {
    const database = createTestLabD1Database();
    const received: unknown[] = [];
    const runtimeFetch = vi.fn(async (request: Request) => {
      const payload = z
        .object({
          runId: z.string(),
          profile: z.string(),
          connection: z.json(),
          execution: z.json(),
        })
        .parse(await request.json());
      received.push(payload);
      expect(new URL(request.url).pathname).toBe(
        `/_runtime/controllers/${payload.runId}/connection`,
      );
      return Response.json({
        runId: payload.runId,
        exchangeId: "exchange_1",
        acceptance: "accepted",
        reply: { token: "browser-only" },
        diagnostics: { native: [1, 2] },
      });
    });
    try {
      const runIds: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const body: LabStartFixture = {
          profile: "test-connection",
          connection: { exchangeId: "exchange_1", input: { token: "opaque" } },
          selection: originalRealtimeSelection,
          agentInput: createInterviewConversationInput("Lab instructions"),
        };
        if (attempt === 1)
          body.agentInput = createInterviewConversationInput(
            "Lab instructions",
            "  Lab closing policy  ",
          );
        const response = await labWorker.fetch(
          new Request(`${labUrl}/_api/runtime/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          {
            LAB_STARTUP_DEADLINE: startupDeadline,
            LAB_DB: database.d1,
            RUNTIME_WORKER: runtimeBindingWithCatalogCheck(runtimeFetch),
          },
        );
        const runId = requireResponseHeader(response, "X-Lab-Run-Id");
        runIds.push(runId);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          runId,
          exchangeId: "exchange_1",
          acceptance: "accepted",
          reply: { token: "browser-only" },
          diagnostics: { native: [1, 2] },
        });
      }
      expect(runIds[0]).not.toBe(runIds[1]);
      for (const [index, runId] of runIds.entries()) {
        expect(received[index]).toMatchObject({
          runId,
          profile: "test-connection",
          connection: { exchangeId: "exchange_1", input: { token: "opaque" } },
          execution: {
            agentInput: {
              contract: "original-interview-input/v1",
              interviewingDurationMs: 300_000,
              interviewing: { instructions: { kind: "literal", text: "Lab instructions" } },
            },
          },
        });
      }
      expect(received[1]).toMatchObject({
        execution: {
          agentInput: {
            interviewing: { toolDescriptions: { finish_interview: "  Lab closing policy  " } },
          },
        },
      });
      expect(received[0]).toHaveProperty(
        "execution.agentInput.interviewing.toolDescriptions.finish_interview",
        defaultFinishInterviewDescription,
      );
      expect(await listLabRuns(database.d1)).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("relays a successive exchange only for an existing Lab run without another admission", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1);
    const runtimeFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        `/_runtime/controllers/${created.runId}/connection`,
      );
      expect(await request.json()).toEqual({
        runId: created.runId,
        connection: { exchangeId: "next", input: ["opaque", 2] },
      });
      return Response.json({
        runId: created.runId,
        exchangeId: "next",
        acceptance: "accepted",
        reply: { next: true },
      });
    });
    try {
      for (const runId of [created.runId, "missing"]) {
        const response = await labWorker.fetch(
          new Request(`${labUrl}/_api/runtime/runs/${runId}/connection`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ exchangeId: "next", input: ["opaque", 2] }),
          }),
          {
            LAB_STARTUP_DEADLINE: startupDeadline,
            LAB_DB: database.d1,
            RUNTIME_WORKER: { fetch: runtimeFetch },
          },
        );
        expect(response.status).toBe(runId === created.runId ? 200 : 404);
        if (runId === created.runId)
          await expect(response.json()).resolves.toEqual({
            runId,
            exchangeId: "next",
            acceptance: "accepted",
            reply: { next: true },
          });
      }
      expect(runtimeFetch).toHaveBeenCalledTimes(1);
      expect(await listLabRuns(database.d1)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      profile: "realtime-v1",
      connection: { input: "missing-identity" },
      selection: originalRealtimeSelection,
      agentInput: createInterviewConversationInput("Ask why"),
    },
    {
      profile: "realtime-v1",
      connection: { exchangeId: "first" },
      selection: originalRealtimeSelection,
      agentInput: createInterviewConversationInput("Ask why"),
      startupExpiresAt: 123,
    },
    {
      profile: "realtime-v1",
      connection: { exchangeId: "first" },
      selection: originalRealtimeSelection,
      agentInput: createInterviewConversationInput("Ask why"),
      execution: { kind: "configured_interview", agentInput: {} },
    },
  ])(
    "rejects malformed connection start envelopes, and fields Lab does not take, before admission",
    async (body) => {
      const database = createTestLabD1Database();
      const runtimeFetch = vi.fn();
      try {
        const response = await labWorker.fetch(
          new Request(`${labUrl}/_api/runtime/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          {
            LAB_STARTUP_DEADLINE: startupDeadline,
            LAB_DB: database.d1,
            RUNTIME_WORKER: { fetch: runtimeFetch },
          },
        );
        expect(response.status).toBe(400);
        expect(await listLabRuns(database.d1)).toHaveLength(0);
        expect(runtimeFetch).not.toHaveBeenCalled();
      } finally {
        database.close();
      }
    },
  );

  it("reports Lab health and binding shape", async () => {
    const database = createTestLabD1Database();

    try {
      const response = await labWorker.fetch(new Request(`${labUrl}/health`), {
        LAB_STARTUP_DEADLINE: startupDeadline,
        LAB_DB: database.d1,
        RUNTIME_WORKER: {
          fetch() {
            return new Response(null, { status: 204 });
          },
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        service: "lab",
        hasRuntimeWorkerBinding: true,
        hasLabDatabaseBinding: true,
      });
    } finally {
      database.close();
    }
  });

  it("answers CORS preflight before route handling", async () => {
    const response = await labWorker.fetch(
      new Request(`${labUrl}/_api/runtime/runs`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://lab.example.test",
        },
      }),
      {
        ALLOWED_ORIGIN: "https://lab.example.test",
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://lab.example.test");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
  });

  it("purges expired shared diagnostics events from the scheduled Lab cleanup", async () => {
    const database = createTestLabD1Database();
    const scheduledTime = 1_700_000_000_000;
    const expiredObservedAt = scheduledTime - runDiagnosticEventRetentionMs - 1;
    const created = await createLabRun(database.d1, {
      now: () => scheduledTime,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await appendRuntimeEvents(database.d1, {
        runId: created.runId,
        records: [
          {
            observedAt: expiredObservedAt,
            sequence: 1,
            elapsedMs: 10,
            type: "runtime.expired_fact",
            payload: {
              source: "runtime_controller",
            },
          },
          {
            observedAt: scheduledTime,
            sequence: 2,
            elapsedMs: 20,
            type: "runtime.recent_fact",
            payload: {
              source: "runtime_controller",
            },
          },
        ],
      });

      await labWorker.scheduled(
        {
          cron: "7 3 * * *",
          scheduledTime,
          noRetry: vi.fn(),
        },
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
        },
      );

      await expect(listRuntimeEvents(database.d1, created.runId)).resolves.toMatchObject([
        {
          type: "runtime.recent_fact",
        },
      ]);
      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({
          event: "run_diagnostics_retention_purged",
          service: "lab",
          scheduledTime,
          deletedRunEventCount: 1,
        }),
      );
    } finally {
      logSpy.mockRestore();
      database.close();
    }
  });

  it("persists Lab Runs and setup failures through Lab D1 routes", async () => {
    const database = createTestLabD1Database();

    try {
      const createResponse = await labWorker.fetch(
        new Request(`${labUrl}/_api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            promptProvenance: {
              promptId: "sample-prompt",
              promptFileName: "sample-prompt.md",
              contentHash: "fnv1a64:1234",
            },
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
        },
      );
      const created = z.object({ runId: z.string() }).parse(await createResponse.json());
      const createdRunId = created.runId;

      expect(createResponse.status).toBe(201);
      expect(createdRunId).toMatch(/^lab_/);

      const invalidSetupFailureResponse = await labWorker.fetch(
        new Request(`${labUrl}/_api/runs/${createdRunId}/setup-failure`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ endedAt: "invalid" }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
        },
      );
      const setupFailureResponse = await labWorker.fetch(
        new Request(`${labUrl}/_api/runs/${createdRunId}/setup-failure`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            endedAt: 1_700_000_030_000,
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
        },
      );
      const diagnosticsResponse = await labWorker.fetch(
        new Request(`${labUrl}/_api/runs/${createdRunId}/diagnostics`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId: "rtc_hidden_lab_call",
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
        },
      );
      const detailResponse = await labWorker.fetch(
        new Request(`${labUrl}/_api/runs/${createdRunId}`),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
        },
      );
      const listResponse = await labWorker.fetch(new Request(`${labUrl}/_api/runs`), {
        LAB_STARTUP_DEADLINE: startupDeadline,
        LAB_DB: database.d1,
      });
      const detailBody = await detailResponse.json();
      const listBody = await listResponse.json();

      expect(invalidSetupFailureResponse.status).toBe(400);
      await expect(invalidSetupFailureResponse.json()).resolves.toEqual({
        error: "invalid_lab_run_setup_failure_request",
      });
      expect(setupFailureResponse.status).toBe(200);
      expect(diagnosticsResponse.status).toBe(200);
      expect(detailBody).toMatchObject({
        runId: createdRunId,
        endedAt: 1_700_000_030_000,
        outcome: "failed",
        endReason: "runtime_failed",
        transcriptTurnCount: 0,
        transcript: {
          turns: [],
        },
      });
      expect(listBody).toMatchObject([
        {
          runId: createdRunId,
          endedAt: 1_700_000_030_000,
          outcome: "failed",
          endReason: "runtime_failed",
          transcriptTurnCount: 0,
        },
      ]);
      expect(JSON.stringify(detailBody)).not.toContain("rtc_hidden_lab_call");
      expect(JSON.stringify(listBody)).not.toContain("rtc_hidden_lab_call");
      expect(JSON.stringify(detailBody)).not.toContain("run.started");
    } finally {
      database.close();
    }
  });

  it("answers an unknown route not_found without calling Runtime", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1);
    const runtimeFetch = vi.fn();

    try {
      for (const path of ["/_api/unknown", `/_api/runtime/runs/${created.runId}/unknown`]) {
        const response = await labWorker.fetch(
          new Request(`${labUrl}${path}`, { method: "POST" }),
          {
            LAB_STARTUP_DEADLINE: startupDeadline,
            LAB_DB: database.d1,
            RUNTIME_WORKER: { fetch: runtimeFetch },
          },
        );

        expect(response.status, path).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: "not_found" });
      }
      expect(runtimeFetch).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("proves Lab-to-Runtime wiring through a non-secret Runtime health check", async () => {
    const runtimeFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);

      expect(url.pathname).toBe("/health");

      return Response.json({
        ok: true,
        service: "runtime",
      });
    });

    const response = await labWorker.fetch(new Request(`${labUrl}/_api/runtime/health`), {
      RUNTIME_WORKER: {
        fetch: runtimeFetch,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "runtime",
    });
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
  });

  it("reports disconnected Runtime Worker service bindings through Runtime health", async () => {
    const response = await labWorker.fetch(new Request(`${labUrl}/_api/runtime/health`), {
      RUNTIME_WORKER: {
        fetch() {
          return new Response('Worker "eventpulse-runtime" not found', {
            status: 503,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
            },
          });
        },
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "runtime_worker_unavailable",
      reason: "service_binding_unavailable",
      message: "Runtime Worker is not reachable through the RUNTIME_WORKER service binding.",
      recovery:
        "Start the Runtime Worker first, restart the Lab Worker, then check /_api/runtime/health.",
    });
  });

  it("delegates Realtime call creation to the Runtime Worker service binding", async () => {
    const database = createTestLabD1Database();
    const runtimeFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const body = await request.json();
      const { runId, createdAt } = z
        .object({ runId: z.string(), createdAt: z.number() })
        .parse(body);
      const settingsSummary = summarizePreparedModelSession(
        prepareRealtimeSettings({ reasoningEffort: "high" }),
      );
      const requestedSessionWithCap = { ...settingsSummary, maxOutputTokens: 700 };

      expect(url.pathname).toBe(`/_runtime/controllers/${runId}/connection`);
      expect(runId).toMatch(/^lab_/);
      expect(body).toEqual({
        runId,
        createdAt,
        startupExpiresAt: createdAt + 30_000,
        selection: originalRealtimeSelection,
        profile: "realtime-v1",
        connection: { exchangeId: "initial", input: { sdp: "v=0" } },
        execution: rawExecution(),
        executionSettings: {
          model: "gpt-realtime-2.1",
          voice: "marin",
          speed: 1,
          inputNoiseReduction: "far_field",
          semanticVadEagerness: "medium",
          maxOutputTokens: 700,
          truncation: "auto",
        },
        reasoningEffort: "high",
        deliveryTarget: { integration: "lab", context: { runId } },
        diagnosticsContext: {
          surface: "lab",
          environment: "local",
          appResourceKind: "lab_run",
          appResourceId: runId,
        },
      });

      return new Response("answer-sdp", {
        status: 201,
        headers: {
          "Content-Type": "application/sdp",
          [SETTINGS_SUMMARY_HEADER]: encodeURIComponent(JSON.stringify(requestedSessionWithCap)),
        },
      });
    });

    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            profile: "realtime-v1",
            connection: { exchangeId: "initial", input: { sdp: "v=0" } },
            selection: originalRealtimeSelection,
            agentInput: createInterviewConversationInput("Lab prompt"),
            reasoningEffort: "high",
            promptProvenance: {
              promptId: "sample-prompt",
              promptFileName: "sample-prompt.md",
              contentHash: "fnv1a64:1234",
            },
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: runtimeBindingWithCatalogCheck(runtimeFetch),
        },
      );

      expect(response.status).toBe(201);
      expect(response.headers.get(SETTINGS_SUMMARY_HEADER)).toBeNull();
      const runId = requireResponseHeader(response, "X-Lab-Run-Id");
      expect(runId).toMatch(/^lab_/);
      expect(Number(response.headers.get("X-Lab-Run-Started-At"))).toEqual(expect.any(Number));
      await expect(response.text()).resolves.toBe("answer-sdp");
      expect(runtimeFetch).toHaveBeenCalledTimes(1);
      await expect(getRunDiagnostics(database.d1, runId)).resolves.toMatchObject({
        runId,
        settingsSummary: { model: "gpt-realtime-2.1", maxOutputTokens: 700 },
        promptProvenance: {
          promptId: "sample-prompt",
          promptFileName: "sample-prompt.md",
          contentHash: "fnv1a64:1234",
        },
      });
      await expect(getRunDiagnostics(database.d1, runId)).resolves.not.toMatchObject({
        sessionId: "rtc_provider_call",
      });
      await expect(listRuntimeEvents(database.d1, runId)).resolves.toEqual([]);
      await expect(getLabRun(database.d1, runId)).resolves.toMatchObject({
        executionModel: "gpt-realtime-2.1",
        maxOutputTokens: 700,
        responseUsage: [],
      });
    } finally {
      database.close();
    }
  });

  it.each([
    { body: "v=0", contentType: "application/sdp" },
    { body: "{", contentType: "application/json" },
    { body: '{"prompt":"Hello"}', contentType: "application/json" },
    { body: '{"sdp":"v=0","prompt":42}', contentType: "application/json" },
  ])(
    "refuses a Start that is not a connection exchange at the real route: $body",
    async ({ body, contentType }) => {
      const database = createTestLabD1Database();
      const runtimeFetch = vi.fn();
      try {
        const response = await labWorker.fetch(
          new Request(`${labUrl}/_api/runtime/runs`, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body,
          }),
          {
            LAB_STARTUP_DEADLINE: startupDeadline,
            LAB_DB: database.d1,
            RUNTIME_WORKER: { fetch: runtimeFetch },
          },
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "invalid_run_start_request" });
        expect(runtimeFetch).not.toHaveBeenCalled();
      } finally {
        database.close();
      }
    },
  );

  it("rejects invalid Lab Realtime settings before starting a Runtime Run", async () => {
    const database = createTestLabD1Database();
    const runtimeFetch = vi.fn();
    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: "realtime-v1",
            connection: { exchangeId: "initial", input: { sdp: "v=0" } },
            selection: originalRealtimeSelection,
            agentInput: createInterviewConversationInput("Ask why"),
            executionSettings: {
              model: "gpt-realtime-2.1",
              voice: "cedar",
              speed: 2,
              inputNoiseReduction: "off",
              semanticVadEagerness: "high",
              maxOutputTokens: 1000,
              truncation: "disabled",
            },
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: runtimeBindingWithCatalogCheck(runtimeFetch),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_execution_settings" });
      expect(runtimeFetch).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("rejects missing caller input before Runtime dispatch", async () => {
    const database = createTestLabD1Database();
    const runtimeFetch = vi.fn();
    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selection: originalRealtimeSelection,
            profile: "realtime-v1",
            connection: { exchangeId: "initial", input: { sdp: "v=0" } },
          }),
        }),
        {
          LAB_DB: database.d1,
          LAB_STARTUP_DEADLINE: startupDeadline,
          RUNTIME_WORKER: { fetch: runtimeFetch },
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_run_start_request" });
      expect(runtimeFetch).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  // Runtime's catalog decides; Lab keeps the response it gave when it decoded input itself.
  it.each([
    {
      name: "a malformed input",
      selection: originalRealtimeSelection,
      agentInput: { instructions: "Lab prompt" },
      error: "The boundary schema rejected the input",
    },
    {
      name: "Original input for Goodbye",
      selection: {
        conversation: { id: "goodbye-interview", version: 1 },
        execution: { id: "realtime", version: 1 },
      },
      agentInput: createInterviewConversationInput("Lab prompt"),
      error: "The boundary schema rejected the input",
    },
    {
      name: "Goodbye input for Questions on Cascade",
      selection: {
        conversation: { id: "questions-interview", version: 1 },
        execution: { id: "cascade", version: 1 },
      },
      agentInput: createGoodbyeConversationInput(
        goodbyeInterviewInstructions,
        goodbyeFinishDescription,
        defaultClosingSentence,
      ),
      error: "The boundary schema rejected the input",
    },
    {
      name: "an unknown Conversation",
      selection: {
        conversation: { id: "unknown-interview", version: 1 },
        execution: { id: "realtime", version: 1 },
      },
      agentInput: createInterviewConversationInput("Lab prompt"),
      error: "conversation_selection_unavailable",
    },
    {
      name: "an unknown execution",
      selection: {
        conversation: { id: "original-interview", version: 1 },
        execution: { id: "cascade", version: 2 },
      },
      agentInput: createInterviewConversationInput("Lab prompt"),
      error: "conversation_selection_unavailable",
    },
  ])(
    "refuses $name with its previous response and no Runtime start",
    async ({ selection, agentInput, error }) => {
      const database = createTestLabD1Database();
      const starts: string[] = [];
      try {
        const response = await labWorker.fetch(
          new Request(`${labUrl}/_api/runtime/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              selection,
              profile: "realtime-v1",
              connection: { exchangeId: "initial", input: { sdp: "v=0" } },
              agentInput,
            }),
          }),
          {
            LAB_DB: database.d1,
            LAB_STARTUP_DEADLINE: startupDeadline,
            RUNTIME_WORKER: runtimeBindingWithCatalogCheck((request) => {
              starts.push(new URL(request.url).pathname);
              return Response.json({ accepted: true });
            }),
          },
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error });
        expect(starts).toEqual([]);
        const [run] = await listLabRuns(database.d1);
        if (run === undefined) throw new Error("missing_lab_run");
        await expect(getRunDiagnostics(database.d1, run.runId)).resolves.toMatchObject({
          setupFailure: { failureKind: "provider_signaling", source: "lab_worker", code: error },
        });
      } finally {
        database.close();
      }
    },
  );

  // Runtime's Start answers a combination it lacks credentials for 503; Lab answers the same.
  it("refuses a combination Runtime cannot start as unavailable, naming the missing credential, with no Runtime start", async () => {
    const database = createTestLabD1Database();
    const starts: string[] = [];
    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selection: originalRealtimeSelection,
            profile: "realtime-v1",
            connection: { exchangeId: "initial", input: { sdp: "v=0" } },
            agentInput: createInterviewConversationInput("Lab prompt"),
          }),
        }),
        {
          LAB_DB: database.d1,
          LAB_STARTUP_DEADLINE: startupDeadline,
          RUNTIME_WORKER: runtimeBindingWithCatalogCheck(
            (request) => {
              starts.push(new URL(request.url).pathname);
              return Response.json({ accepted: true });
            },
            { SONIOX_API_KEY: "soniox-test" },
          ),
        },
      );
      const [run] = await listLabRuns(database.d1);
      if (run === undefined) throw new Error("missing_lab_run");
      expect(response.status).toBe(503);
      expect(response.headers.get("X-Lab-Run-Id")).toBe(run.runId);
      await expect(response.json()).resolves.toEqual({
        error: "missing_credentials:OPENAI_API_KEY",
      });
      expect(starts).toEqual([]);
      await expect(getRunDiagnostics(database.d1, run.runId)).resolves.toMatchObject({
        setupFailure: {
          failureKind: "provider_signaling",
          source: "lab_worker",
          code: "missing_credentials:OPENAI_API_KEY",
        },
      });
    } finally {
      database.close();
    }
  });

  it("delegates run-level Runtime Controller close for a Lab Run", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });
    const runtimeFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const body = await request.json();

      expect(request.method).toBe("POST");
      expect(url.pathname).toBe(`/_runtime/controllers/${created.runId}/complete`);
      expect(body).toEqual({
        runId: created.runId,
        endReason: "participant_stopped",
        source: "browser_close",
        microphoneStoppedAt: 1_700_000_001_234,
      });

      return Response.json({
        ok: true,
      });
    });

    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs/${encodeURIComponent(created.runId)}/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            endReason: "participant_stopped",
            microphoneStoppedAt: 1_700_000_001_234,
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: {
            fetch: runtimeFetch,
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(runtimeFetch).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("rejects an unknown end reason at the Lab boundary", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1);
    const runtimeFetch = vi.fn();
    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs/${encodeURIComponent(created.runId)}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endReason: "future_reason" }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: { fetch: runtimeFetch },
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_end_reason" });
      expect(runtimeFetch).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("forwards browser presence heartbeats to the Runtime Controller", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });
    const runtimeFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const body = await request.json();

      expect(request.method).toBe("POST");
      expect(url.pathname).toBe(`/_runtime/controllers/${created.runId}/presence`);
      expect(body).toEqual({
        runId: created.runId,
        mediaPresent: false,
      });

      return Response.json({
        accepted: true,
      });
    });

    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/presence?runId=${created.runId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mediaPresent: false,
            now: 1_700_000_010_000,
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: {
            fetch: runtimeFetch,
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ accepted: true });
      expect(runtimeFetch).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("forwards media readiness for an existing Lab run and rejects invalid requests", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1, { now: () => 1_700_000_000_000 });
    const forwarded: Array<{ path: string; method: string; body: unknown }> = [];
    const runtimeFetch = vi.fn(async (request: Request) => {
      forwarded.push({
        path: new URL(request.url).pathname,
        method: request.method,
        body: await request.json(),
      });
      return Response.json({ ok: true });
    });
    const env = {
      LAB_STARTUP_DEADLINE: startupDeadline,
      LAB_DB: database.d1,
      RUNTIME_WORKER: { fetch: runtimeFetch },
    };
    const path = `${labUrl}/_api/runtime/runs/${created.runId}/media-ready`;
    try {
      for (const body of ["{}", '{"runId":"another_run","mediaPresent":false}']) {
        const response = await labWorker.fetch(
          new Request(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
          env,
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true });
      }
      for (const body of ["null", "[]", '"ready"', "42", "{", ""]) {
        const response = await labWorker.fetch(
          new Request(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
          env,
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: "invalid_runtime_media_ready_request",
        });
      }
      const absent = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs/missing/media-ready`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        env,
      );
      expect(absent.status).toBe(404);
      await expect(absent.json()).resolves.toEqual({ error: "lab_run_not_found" });
      expect(forwarded).toEqual([
        {
          path: `/_runtime/controllers/${created.runId}/media-ready`,
          method: "POST",
          body: { runId: created.runId },
        },
        {
          path: `/_runtime/controllers/${created.runId}/media-ready`,
          method: "POST",
          body: { runId: created.runId },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects Lab presence heartbeats without an explicit media state", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });
    const runtimeFetch = vi.fn();

    try {
      for (const body of [{}, { mediaPresent: null }, { mediaPresent: "false" }]) {
        const response = await labWorker.fetch(
          new Request(`${labUrl}/_api/runtime/presence?runId=${created.runId}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }),
          {
            LAB_STARTUP_DEADLINE: startupDeadline,
            LAB_DB: database.d1,
            RUNTIME_WORKER: {
              fetch: runtimeFetch,
            },
          },
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: "invalid_runtime_presence_request",
        });
      }
      expect(runtimeFetch).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("returns a structured Start error when the Runtime Worker binding is disconnected", async () => {
    const database = createTestLabD1Database();

    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            profile: "realtime-v1",
            connection: { exchangeId: "initial", input: { sdp: "v=0" } },
            selection: originalRealtimeSelection,
            agentInput: createInterviewConversationInput("Lab prompt"),
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: {
            fetch() {
              return new Response('Worker "eventpulse-runtime" not found', {
                status: 503,
                headers: {
                  "Content-Type": "text/plain; charset=utf-8",
                },
              });
            },
          },
        },
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: "runtime_worker_unavailable",
        reason: "service_binding_unavailable",
      });
      const runId = requireResponseHeader(response, "X-Lab-Run-Id");
      expect(runId).toMatch(/^lab_/);
      await expect(getRunDiagnostics(database.d1, runId)).resolves.toMatchObject({
        setupFailure: {
          failureKind: "runtime_worker_unavailable",
          source: "lab_worker",
          code: "service_binding_unavailable",
        },
      });
    } finally {
      database.close();
    }
  });

  it("does not synthesize a terminal Lab result after an ambiguous Runtime start failure", async () => {
    const database = createTestLabD1Database();

    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: "realtime-v1",
            connection: { exchangeId: "initial", input: { sdp: "v=0" } },
            selection: originalRealtimeSelection,
            agentInput: createInterviewConversationInput("Lab prompt"),
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: runtimeBindingWithCatalogCheck(async () => {
            throw new Error("ambiguous_service_binding_failure");
          }),
        },
      );

      expect(response.status).toBe(503);
      const runId = requireResponseHeader(response, "X-Lab-Run-Id");
      const stored = await getLabRun(database.d1, runId);
      if (stored === null) throw new Error("Expected the allocated Lab run.");
      expect(stored.endedAt).toBeUndefined();
      expect(stored.outcome).toBeUndefined();
      expect(stored.endReason).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rejects Lab runtime requests when the Runtime Worker binding is missing", async () => {
    const database = createTestLabD1Database();

    try {
      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: "realtime-v1",
            connection: { exchangeId: "initial", input: { sdp: "v=0" } },
            selection: originalRealtimeSelection,
            agentInput: createInterviewConversationInput("Ask why"),
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
        },
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "runtime_worker_unavailable",
        reason: "missing_binding",
        message: "Runtime Worker is not reachable through the RUNTIME_WORKER service binding.",
        recovery:
          "Start the Runtime Worker first, restart the Lab Worker, then check /_api/runtime/health.",
      });
      const runId = requireResponseHeader(response, "X-Lab-Run-Id");
      expect(runId).toMatch(/^lab_/);
      await expect(getRunDiagnostics(database.d1, runId)).resolves.toMatchObject({
        setupFailure: {
          failureKind: "runtime_worker_unavailable",
          source: "lab_worker",
          code: "missing_binding",
        },
      });
      await expect(getLabRun(database.d1, runId)).resolves.toMatchObject({
        runId,
        outcome: "failed",
        endReason: "runtime_failed",
      });
    } finally {
      database.close();
    }
  });

  it("persists controller-owned Runtime Events while proxying browser-safe stream events", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });
    const runtimeFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);

      expect(url.pathname).toBe(`/_runtime/controllers/${created.runId}/events`);
      expect(url.searchParams.get("sessionId")).toBe("rtc_provider_call");
      expect(url.searchParams.get("durationMs")).toBe("480000");

      return new Response(
        [
          sse("session.connected", {
            runId: created.runId,
            sessionId: "rtc_provider_call",
            readyState: 1,
          }),
          sse("session.control_sent", {
            runId: created.runId,
            sessionId: "rtc_provider_call",
            controlType: "response.create",
          }),
          sse("runtime.event_recorded", {
            runId: created.runId,
            record: {
              recordId: created.runId + ":1",
              runId: created.runId,
              source: "runtime",
              selection: null,
              visitId: null,
              operationId: null,
              observedAt: Date.now(),
              sequence: 1,
              elapsedMs: 50,
              type: "runtime.live_reached",
              payloadJson: JSON.stringify({
                source: "runtime_controller",
                sessionId: "rtc_provider_call",
              }),
            },
          }),
          sse("runtime.transcript_persisted", {
            runId: created.runId,
            turnCount: 1,
            stored: true,
          }),
          sse("sideband.websocket_error", {
            runId: created.runId,
            message: "OpenAI sideband WebSocket closed unexpectedly.",
          }),
          sse("sideband.websocket_error", {
            runId: created.runId,
            message: "Duplicate WebSocket warning.",
          }),
          sse("runtime.event_recorded", {
            runId: created.runId,
            record: {
              recordId: created.runId + ":2",
              runId: created.runId,
              source: "runtime",
              selection: null,
              visitId: null,
              operationId: null,
              observedAt: Date.now(),
              sequence: 2,
              elapsedMs: 100,
              type: "realtime.provider_event_observed",
              payloadJson: JSON.stringify({
                providerEventType: "response.done",
                source: "provider",
                provider: "openai_realtime",
              }),
            },
          }),
          sse("runtime.event_recorded", {
            runId: created.runId,
            record: {
              recordId: created.runId + ":3",
              runId: created.runId,
              source: "runtime",
              selection: null,
              visitId: null,
              operationId: null,
              observedAt: Date.now(),
              sequence: 3,
              elapsedMs: 120,
              type: "runtime.future_runtime_fact",
              payloadJson: JSON.stringify({
                source: "runtime_controller",
                feature: "future-proof",
              }),
            },
          }),
          sse("sideband.provider_error", {
            runId: created.runId,
            error: {
              code: "input_audio_buffer_commit_empty",
              message: "Optional final input commit was empty.",
            },
          }),
          sse("sideband.provider_error", {
            runId: created.runId,
            error: {
              code: "provider_error",
              message: "Provider reported a compact error.",
            },
          }),
          sse("runtime.event_recorded", {
            runId: created.runId,
            record: {
              recordId: created.runId + ":4",
              runId: created.runId,
              source: "runtime",
              selection: null,
              visitId: null,
              operationId: null,
              observedAt: Date.now(),
              sequence: 4,
              elapsedMs: 160,
              type: "runtime.live_degraded",
              payloadJson: JSON.stringify({
                source: "provider",
                provider: "openai_realtime",
                sessionId: "rtc_provider_call",
                degradationKind: "provider_error",
                errorText: "Provider reported a compact error.",
                code: "provider_error",
              }),
            },
          }),
          sse("session.failed", {
            runId: created.runId,
            message: "OpenAI sideband failed while live.",
          }),
          sse("session.failed", {
            runId: created.runId,
            message: "Duplicate sideband failure.",
          }),
          sse("runtime.agent_completed_interview", {
            runId: created.runId,
            sessionId: "rtc_provider_call",
            toolName: FINISH_INTERVIEW_TOOL_NAME,
          }),
          sse("runtime.controller_close_requested", {
            runId: created.runId,
            endReason: "agent_requested_end",
            source: "agent_completion",
          }),
          sse("runtime.event_recorded", {
            runId: created.runId,
            record: {
              recordId: created.runId + ":5",
              runId: created.runId,
              source: "runtime",
              selection: null,
              visitId: null,
              operationId: null,
              observedAt: Date.now(),
              sequence: 5,
              elapsedMs: 190,
              type: "runtime.ending_started",
              payloadJson: JSON.stringify({
                source: "runtime_controller",
                endReason: "agent_requested_end",
                trigger: "provider_tool_call",
              }),
            },
          }),
          sse("session.closed", {
            runId: created.runId,
            sessionId: "rtc_provider_call",
            reason: "test_complete",
            eventCount: 1,
            eventTypeCounts: {
              "response.done": 1,
            },
          }),
          sse("runtime.event_recorded", {
            runId: created.runId,
            record: {
              recordId: created.runId + ":6",
              runId: created.runId,
              source: "runtime",
              selection: null,
              visitId: null,
              operationId: null,
              observedAt: Date.now(),
              sequence: 6,
              elapsedMs: 220,
              type: "realtime.sideband_closed",
              payloadJson: JSON.stringify({
                source: "runtime_controller",
                provider: "openai_realtime",
                reason: "test_complete",
                eventCount: 1,
              }),
            },
          }),
        ].join(""),
        {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
          },
        },
      );
    });

    try {
      const response = await labWorker.fetch(
        new Request(
          `${labUrl}/_api/runtime/events?runId=${created.runId}&sessionId=rtc_provider_call&durationMs=480000`,
        ),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: {
            fetch: runtimeFetch,
          },
        },
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("event: session.connected");
      expect(body).toContain("event: runtime.transcript_persisted");
      expect(body).toContain("event: runtime.event_recorded");
      expect(body).toContain("event: runtime.agent_completed_interview");
      expect(body).toContain("event: session.closed");
      await expect(
        labWorker
          .fetch(new Request(`${labUrl}/_api/runs/${created.runId}`), {
            LAB_STARTUP_DEADLINE: startupDeadline,
            LAB_DB: database.d1,
          })
          .then((detail) => detail.json()),
      ).resolves.toMatchObject({
        runId: created.runId,
        transcriptTurnCount: 0,
        transcript: {
          turns: [],
        },
      });
      const events = await listRuntimeEvents(database.d1, created.runId);
      expect(events.map((event) => event.type)).toEqual([
        "runtime.live_reached",
        "realtime.provider_event_observed",
        "runtime.future_runtime_fact",
        "runtime.live_degraded",
        "runtime.ending_started",
        "realtime.sideband_closed",
      ]);
      const degradationPayloads = events
        .filter((event) => event.type === "runtime.live_degraded")
        .map((event) =>
          z
            .object({
              degradationKind: z.string(),
              code: z.string().optional(),
              errorText: z.string().optional(),
              source: z.string().optional(),
            })
            .parse(JSON.parse(event.payloadJson)),
        );
      expect(degradationPayloads).toHaveLength(1);
      expect(degradationPayloads.map((payload) => payload.degradationKind)).toEqual([
        "provider_error",
      ]);
      expect(degradationPayloads).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "input_audio_buffer_commit_empty",
          }),
        ]),
      );
      expect(degradationPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "provider",
            degradationKind: "provider_error",
            errorText: "Provider reported a compact error.",
            code: "provider_error",
          }),
        ]),
      );
      expect(JSON.parse(requireDefined(events[2], "missing_runtime_event").payloadJson)).toEqual({
        source: "runtime_controller",
        feature: "future-proof",
      });
    } finally {
      database.close();
    }
  });

  it("continues Lab Runtime event streaming when diagnostics append fails", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });
    const runtimeFetch = vi.fn(async () => {
      return new Response(
        [
          sse("runtime.event_recorded", {
            runId: created.runId,
            record: {
              recordId: created.runId + ":1",
              runId: created.runId,
              source: "runtime",
              selection: null,
              visitId: null,
              operationId: null,
              observedAt: Date.now(),
              sequence: 1,
              elapsedMs: 100,
              type: "runtime.future_runtime_fact",
              payloadJson: '{"source":"runtime_controller"}',
            },
          }),
          sse("session.closed", {
            runId: created.runId,
            reason: "test_complete",
          }),
        ].join(""),
        {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
          },
        },
      );
    });

    try {
      await database.d1.prepare("DROP TABLE runtime_events").run();

      const response = await labWorker.fetch(
        new Request(`${labUrl}/_api/runtime/events?runId=${created.runId}`),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
          RUNTIME_WORKER: {
            fetch: runtimeFetch,
          },
        },
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("event: session.closed");
      expect(body).toContain("runtime.event_recorded");
    } finally {
      database.close();
    }
  });

  it("persists Lab's Transcript callback without a browser sideband stream", async () => {
    const database = createTestLabD1Database();
    const created = await createLabRun(database.d1, {
      now: () => 1_700_000_000_000,
    });
    const transcriptSnapshot = await createRuntimeTranscriptSnapshot(1, {
      turns: [{ role: "participant", text: "The hallway track was useful." }],
    });

    try {
      const response = await handleLabRuntimeControllerTranscript(
        new Request(applicationCallbackUrl("transcript"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            version: 2,
            type: "runtimeTranscriptUpdated",
            runId: created.runId,
            snapshot: transcriptSnapshot,
          }),
        }),
        {
          LAB_STARTUP_DEADLINE: startupDeadline,
          LAB_DB: database.d1,
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        version: 2,
        status: "stored",
        requestedMatches: true,
      });
      await expect(
        labWorker
          .fetch(new Request(`${labUrl}/_api/runs/${created.runId}`), {
            LAB_STARTUP_DEADLINE: startupDeadline,
            LAB_DB: database.d1,
          })
          .then((detail) => detail.json()),
      ).resolves.toMatchObject({
        runId: created.runId,
        transcriptTurnCount: 1,
        transcript: {
          turns: [
            {
              role: "participant",
              text: "The hallway track was useful.",
            },
          ],
        },
      });
    } finally {
      database.close();
    }
  });
});

function requireResponseHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (value === null) {
    throw new Error(`missing_test_response_header:${name}`);
  }

  return value;
}

function requireDefined<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

function sse<Data>(event: string, data: Data): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("Lab Cascade participation routes", () => {
  it.each([
    ["Original", "original-interview", createInterviewConversationInput("Ask what worked well.")],
    [
      "Goodbye",
      "goodbye-interview",
      createGoodbyeConversationInput(
        goodbyeInterviewInstructions,
        goodbyeFinishDescription,
        defaultClosingSentence,
      ),
    ],
    [
      "Questions",
      "questions-interview",
      createQuestionsConversationInput(
        questionPromptPresets,
        nextQuestionDescription,
        goodbyeFinishDescription,
        defaultClosingSentence,
      ),
    ],
  ])(
    "starts Cascade %s with its media profile and no Realtime settings",
    async (_, id, agentInput) => {
      const cascadeSelection = {
        conversation: { id, version: 1 },
        execution: { id: "cascade", version: 1 },
      };
      const database = createTestLabD1Database();
      const dispatched: { url: string; body: unknown }[] = [];
      try {
        const response = await labWorker.fetch(
          new Request(`${labUrl}/_api/runtime/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              attemptId: "4c8f4f2e-41c6-4c3c-9a3e-3f6b8d1b0c11",
              profile: "cascade-media-v1",
              connection: { exchangeId: "cascade-start", input: {} },
              selection: cascadeSelection,
              agentInput,
              reasoningEffort: "low",
            }),
          }),
          {
            LAB_DB: database.d1,
            LAB_STARTUP_DEADLINE: startupDeadline,
            RUNTIME_WORKER: runtimeBindingWithCatalogCheck(async (request) => {
              dispatched.push({ url: new URL(request.url).pathname, body: await request.json() });
              return Response.json({ accepted: true });
            }),
          },
        );
        expect(response.status).toBe(200);
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]?.url).toBe(
          "/_runtime/controllers/lab_4c8f4f2e-41c6-4c3c-9a3e-3f6b8d1b0c11/connection",
        );
        expect(dispatched[0]?.body).toMatchObject({
          profile: "cascade-media-v1",
          connection: { exchangeId: "cascade-start", input: {} },
          selection: cascadeSelection,
          execution: { agentInput },
        });
        expect(dispatched[0]?.body).not.toHaveProperty("executionSettings");
      } finally {
        database.close();
      }
    },
  );

  const cascadeOriginal = {
    conversation: { id: "original-interview", version: 1 },
    execution: { id: "cascade", version: 1 },
  };
  const cascadeStart = (executionSettings: LabCascadeExecutionSettings) =>
    new Request(`${labUrl}/_api/runtime/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attemptId: "6a1d0c55-0f7e-4f7c-8f43-2b1f0f6c9e21",
        profile: "cascade-media-v1",
        connection: { exchangeId: "cascade-start", input: {} },
        selection: cascadeOriginal,
        agentInput: createInterviewConversationInput("Ask what worked well."),
        reasoningEffort: "low",
        executionSettings,
      }),
    });

  it("forwards a Cascade Start's settings to Runtime and keeps them, and the providers Runtime used, with the Lab Run", async () => {
    const database = createTestLabD1Database();
    const dispatched: unknown[] = [];
    const chosen = {
      speechInput: { provider: "soniox", model: "stt-rt-v6" },
      speechOutput: { provider: "soniox", voice: "Nina" },
    };
    try {
      const response = await labWorker.fetch(cascadeStart(chosen), {
        LAB_DB: database.d1,
        LAB_STARTUP_DEADLINE: startupDeadline,
        RUNTIME_WORKER: runtimeBindingWithCatalogCheck(async (request) => {
          const start = z
            .object({ executionSettings: z.json(), reasoningEffort: z.enum(["low"]) })
            .parse(await request.json());
          dispatched.push(start.executionSettings);
          // Runtime's summary of the settings its Cascade session prepared from this Start.
          const summary = summarizeCascadeSettings(
            prepareCascadeSettings(cascadeCombination("original-interview"), {
              requested: start.executionSettings,
              reasoningEffort: start.reasoningEffort,
            }),
          );
          return Response.json(
            { accepted: true },
            { headers: { [SETTINGS_SUMMARY_HEADER]: encodeURIComponent(JSON.stringify(summary)) } },
          );
        }),
      });
      expect(response.status).toBe(200);
      expect(dispatched).toEqual([chosen]);
      const runId = requireResponseHeader(response, "X-Lab-Run-Id");
      const saved = await labWorker.fetch(
        new Request(`${labUrl}/_api/runs/${runId}/start-request`),
        { LAB_DB: database.d1 },
      );
      await expect(saved.json()).resolves.toMatchObject({ executionSettings: chosen });
      const diagnostics = await getRunDiagnostics(database.d1, runId);
      expect(diagnostics?.settingsSummary).toMatchObject({
        speechInput: { provider: "soniox", model: "stt-rt-v6" },
        languageModel: { provider: "cerebras" },
        speechOutput: { provider: "soniox", voice: "Nina" },
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ["another provider's field", { speechInput: { provider: "soniox", voice: "Nina" } }],
    ["an unregistered provider", { languageModel: { provider: "unregistered" } }],
    ["a value outside its provider's list", { speechOutput: { provider: "soniox", voice: "X" } }],
  ])(
    "refuses Cascade settings with %s through Runtime's input check, with no Runtime start",
    async (_, executionSettings) => {
      const database = createTestLabD1Database();
      const starts: string[] = [];
      try {
        const response = await labWorker.fetch(cascadeStart(executionSettings), {
          LAB_DB: database.d1,
          LAB_STARTUP_DEADLINE: startupDeadline,
          RUNTIME_WORKER: runtimeBindingWithCatalogCheck((request) => {
            starts.push(new URL(request.url).pathname);
            return Response.json({ accepted: true });
          }),
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "invalid_execution_settings" });
        expect(starts).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it("offers exactly the providers and listed values Cascade declares, today's first", async () => {
    const response = await labWorker.fetch(new Request(`${labUrl}/_api/cascade-providers`), {});
    expect(response.status).toBe(200);
    const offered = decodeLabCascadeProviderOptions(await response.json());
    for (const component of ["speechInput", "languageModel", "speechOutput"] as const) {
      expect(offered[component].map(({ provider }) => provider)).toEqual(
        cascadeProviderDeclarations[component].map(({ provider }) => provider),
      );
      // Today's provider and its defaults come first: what a Start without settings runs.
      const [today] = offered[component];
      expect(today?.provider).toBe(cascadeDefaultProviderSettings[component].provider);
      const offeredDefaults = Object.fromEntries(
        Object.entries(today?.lists ?? {}).map(([setting, list]) => [setting, list?.default]),
      );
      expect(cascadeDefaultProviderSettings[component]).toMatchObject(offeredDefaults);
      // Runtime accepts every value the page can choose.
      for (const { provider, lists } of offered[component])
        for (const [setting, list] of Object.entries(lists))
          for (const value of list?.values ?? [])
            expect(
              cascadeExecutionSettingsSchema.safeParse({
                [component]: { provider, [setting]: value },
              }).success,
            ).toBe(true);
    }
    // Today's Soniox speech output offers its voices.
    expect(offered.speechOutput[0]?.lists.voice?.values.length).toBeGreaterThan(1);
  });

  it("offers Gradium speech input's turn rule with Cascade's limits and defaults", async () => {
    const response = await labWorker.fetch(new Request(`${labUrl}/_api/cascade-providers`), {});
    const offered = decodeLabCascadeProviderOptions(await response.json());
    const gradium = offered.speechInput.find(({ provider }) => provider === "gradium");
    expect(gradium?.numbers).toEqual({
      turnHorizon: { values: [0.5, 1, 2, 3], default: 2 },
      turnThreshold: { minimum: 0, maximum: 1, integer: false, default: 0.5 },
      turnSteps: { minimum: 1, maximum: 10, integer: true, default: 3 },
    });
    // Only Gradium's turn rule: Soniox's numeric endpoint settings stay off the page.
    for (const component of ["speechInput", "languageModel", "speechOutput"] as const)
      for (const option of offered[component])
        if (option !== gradium) expect(option.numbers).toEqual({});
    // Runtime accepts every value the panel offers and refuses just beyond each limit.
    const accepts = (setting: string, value: number) =>
      cascadeExecutionSettingsSchema.safeParse({
        speechInput: { provider: "gradium", [setting]: value },
      }).success;
    for (const [setting, option] of Object.entries(gradium?.numbers ?? {})) {
      if (option === undefined) continue;
      for (const value of labCascadeNumberChoices(option))
        expect(accepts(setting, value)).toBe(true);
      if (!("values" in option)) {
        expect(accepts(setting, option.minimum - 0.01)).toBe(false);
        expect(accepts(setting, option.maximum + 0.01)).toBe(false);
      }
    }
  });

  it("forwards a media attachment upgrade only for an existing Lab Run", async () => {
    const database = createTestLabD1Database();
    const forwarded: { path: string; upgrade: string | null }[] = [];
    const env = {
      LAB_DB: database.d1,
      RUNTIME_WORKER: {
        fetch: async (request: Request) => {
          forwarded.push({
            path: new URL(request.url).pathname,
            upgrade: request.headers.get("Upgrade"),
          });
          return new Response("attached", { status: 202 });
        },
      },
    };
    try {
      const created = await createLabRun(database.d1);
      const attach = (runId: string, upgrade: boolean) =>
        labWorker.fetch(
          new Request(`${labUrl}/_api/runtime/runs/${runId}/media`, {
            headers: upgrade ? { Upgrade: "websocket" } : {},
          }),
          env,
        );
      const plain = await attach(created.runId, false);
      expect({ status: plain.status, body: await plain.json() }).toEqual({
        status: 426,
        body: { error: "media_attachment_upgrade_required" },
      });
      const unknown = await attach("lab_unknown", true);
      expect({ status: unknown.status, body: await unknown.json() }).toEqual({
        status: 404,
        body: { error: "lab_run_not_found" },
      });
      expect(forwarded).toEqual([]);
      const accepted = await attach(created.runId, true);
      expect({ status: accepted.status, body: await accepted.text() }).toEqual({
        status: 202,
        body: "attached",
      });
      expect(forwarded).toEqual([
        {
          path: `/_runtime/controllers/${encodeURIComponent(created.runId)}/attachment`,
          upgrade: "websocket",
        },
      ]);
    } finally {
      database.close();
    }
  });
});
