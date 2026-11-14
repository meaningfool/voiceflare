import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInterviewConversationInput } from "../data/conversationPresets";

import { readVitestAsymmetricMatcher } from "@/test/domTestSetup";

import {
  LAB_RUN_ID_HEADER,
  LAB_RUN_STARTED_AT_HEADER,
  buildRuntimeCloseUrl,
  buildRuntimePresenceUrl,
  buildRuntimeEventsUrl,
  getProviderCallId,
  decodeRealtimeConnectionReply,
  readRuntimeCompletionPayload,
  requestRuntimeClose,
  RealtimeCallError,
  RUNTIME_WORKER_UNAVAILABLE_MESSAGE,
  sendRuntimePresence,
  sendRuntimeMediaReady,
  signalRealtimeCall,
} from "./realtimeSignaling";

describe("Lab native connection reply boundary", () => {
  const valid = {
    runId: "lab_123",
    exchangeId: "first",
    acceptance: "accepted",
    reply: { sdp: "answer" },
    diagnostics: { sessionId: "rtc_123" },
  };

  it("returns only browser-owned fields from valid replies", () => {
    expect(
      decodeRealtimeConnectionReply({
        ...valid,
        extra: "excluded",
        reply: { ...valid.reply, extra: "excluded" },
        diagnostics: { ...valid.diagnostics, secret: "excluded" },
      }),
    ).toEqual(valid);
    const inheritedExtra: unknown = Object.assign(Object.create({ extra: "excluded" }), valid);
    expect(decodeRealtimeConnectionReply(inheritedExtra)).toEqual(valid);
  });

  it.each(["runId", "exchangeId", "acceptance", "reply", "diagnostics"] as const)(
    "rejects inherited required %s",
    (field) => {
      const ownFields = { ...valid };
      Reflect.deleteProperty(ownFields, field);
      const value: unknown = Object.assign(Object.create({ [field]: valid[field] }), ownFields);
      expect(() => decodeRealtimeConnectionReply(value)).toThrow();
    },
  );

  it("rejects inherited native answer and provider identity", () => {
    const reply: unknown = Object.create({ sdp: "answer" });
    const diagnostics: unknown = Object.create({ sessionId: "rtc_123" });
    expect(() => decodeRealtimeConnectionReply({ ...valid, reply })).toThrow();
    expect(() => decodeRealtimeConnectionReply({ ...valid, diagnostics })).toThrow();
  });

  it.each([
    { ...valid, runId: 42 },
    { ...valid, reply: { sdp: 42 } },
    { ...valid, diagnostics: {} },
    { ...valid, diagnostics: { sessionId: 42 } },
  ])("rejects JSON that violates browser-owned fields", (value) => {
    expect(() => decodeRealtimeConnectionReply(value)).toThrow();
  });
});

describe("Realtime signaling helpers", () => {
  it("rejects a replacement experiment header before publishing allocation", async () => {
    const onRunAllocated = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("answer", {
        headers: {
          [LAB_RUN_ID_HEADER]: "lab_replacement",
          [LAB_RUN_STARTED_AT_HEADER]: "1700000000000",
        },
      }),
    );
    await expect(
      signalRealtimeCall({
        agentInput: createInterviewConversationInput("  Ask why  "),
        endpointBaseUrl: "https://lab.test",
        offerSdp: "v=0",
        attemptId: "2e949a49-15d5-49c3-8d82-5e7fc0f71fb5",
        onRunAllocated,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "lab_connection_identity_mismatch", runIdentity: null });
    expect(onRunAllocated).not.toHaveBeenCalled();
  });
  it.each([
    [{ ok: true }, true],
    [{ ok: false }, false],
    [{}, false],
    [{ ok: "true" }, false],
  ])("accepts only a successful media readiness acknowledgment %j", async (ack, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(ack));
    const ok = await sendRuntimeMediaReady({
      endpointBaseUrl: "https://lab.example",
      runId: "run/one",
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(ok).toBe(expected);
    const sentUrl = fetchImpl.mock.calls[0]?.[0];
    expect(sentUrl instanceof URL ? sentUrl.href : sentUrl).toBe(
      "https://lab.example/_api/runtime/runs/run%2Fone/media-ready",
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: "{}" });
  });

  it("sends a start-time snapshot of Lab Realtime settings", async () => {
    const settings = {
      model: "gpt-realtime-2.1" as const,
      voice: "cedar" as const,
      speed: 1.25,
      inputNoiseReduction: "near_field" as const,
      semanticVadEagerness: "high" as const,
      maxOutputTokens: 1024,
      truncation: "disabled" as const,
    };
    let sentBody = "";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      sentBody = typeof init?.body === "string" ? init.body : "";
      const connection = z
        .object({ connection: z.object({ exchangeId: z.string() }) })
        .parse(JSON.parse(sentBody)).connection;
      return Promise.resolve(
        Response.json(
          {
            runId: "lab_123",
            exchangeId: connection.exchangeId,
            acceptance: "accepted",
            reply: { sdp: "answer-sdp" },
            diagnostics: { sessionId: "rtc_123" },
          },
          {
            headers: {
              [LAB_RUN_ID_HEADER]: "lab_123",
              [LAB_RUN_STARTED_AT_HEADER]: "1700000000000",
            },
          },
        ),
      );
    });
    const start = signalRealtimeCall({
      endpointBaseUrl: "http://127.0.0.1:8795",
      offerSdp: "v=0",
      agentInput: createInterviewConversationInput("  Ask why  ", undefined, 60_000),
      reasoningEffort: "high",
      executionSettings: settings,
      fetchImpl,
    });
    settings.speed = 0.5;
    await expect(start).resolves.toMatchObject({
      runIdentity: { runId: "lab_123", startedAt: 1700000000000 },
      answerSdp: "answer-sdp",
      sessionId: "rtc_123",
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8795/_api/runtime/runs");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(sentBody)).toEqual({
      selection: {
        conversation: { id: "original-interview", version: 1 },
        execution: { id: "realtime", version: 1 },
      },
      agentInput: {
        contract: "original-interview-input/v1",
        interviewingDurationMs: 60_000,
        interviewing: {
          instructions: { kind: "literal", text: "  Ask why  " },
          toolDescriptions: { finish_interview: readVitestAsymmetricMatcher(expect.any(String)) },
        },
      },
      profile: "realtime-v1",
      connection: {
        exchangeId: readVitestAsymmetricMatcher(expect.any(String)),
        input: { sdp: "v=0" },
      },
      reasoningEffort: "high",
      executionSettings: {
        model: "gpt-realtime-2.1",
        voice: "cedar",
        speed: 1.25,
        inputNoiseReduction: "near_field",
        semanticVadEagerness: "high",
        maxOutputTokens: 1024,
        truncation: "disabled",
      },
    });
  });

  it.each([
    { reply: { token: "not-native" }, diagnostics: { sessionId: "rtc_123" } },
    { reply: { sdp: "answer" }, diagnostics: { sessionId: 42 } },
    { reply: { sdp: "answer" } },
    { runId: "other-run", reply: { sdp: "answer" }, diagnostics: { sessionId: "rtc_123" } },
    {
      exchangeId: "other-exchange",
      reply: { sdp: "answer" },
      diagnostics: { sessionId: "rtc_123" },
    },
    {
      acceptance: "unresolved",
      reply: { sdp: "answer" },
      diagnostics: { sessionId: "rtc_123" },
    },
  ])(
    "rejects JSON that cannot drive the native browser while retaining Lab run identity",
    async (reply) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        const request = z
          .object({ connection: z.object({ exchangeId: z.string() }) })
          .parse(JSON.parse(typeof init?.body === "string" ? init.body : ""));
        return Promise.resolve(
          Response.json(
            {
              runId: "lab_123",
              exchangeId: request.connection.exchangeId,
              acceptance: "accepted",
              ...reply,
            },
            {
              headers: {
                [LAB_RUN_ID_HEADER]: "lab_123",
                [LAB_RUN_STARTED_AT_HEADER]: "1700000000000",
              },
            },
          ),
        );
      });
      await expect(
        signalRealtimeCall({
          agentInput: createInterviewConversationInput("  Ask why  "),
          endpointBaseUrl: "http://127.0.0.1:8795",
          offerSdp: "v=0",
          fetchImpl,
        }),
      ).rejects.toMatchObject({
        code: null,
        runIdentity: { runId: "lab_123", startedAt: 1700000000000 },
        message: "Realtime connection returned an invalid browser reply.",
      });
    },
  );

  it("retains the admitted Lab run when the connection response body fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body_lost"));
          },
        }),
        {
          headers: { [LAB_RUN_ID_HEADER]: "lab_123", [LAB_RUN_STARTED_AT_HEADER]: "1700000000000" },
        },
      ),
    );
    await expect(
      signalRealtimeCall({
        agentInput: createInterviewConversationInput("  Ask why  "),
        endpointBaseUrl: "http://127.0.0.1:8795",
        offerSdp: "v=0",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      runIdentity: { runId: "lab_123", startedAt: 1700000000000 },
      message: "Realtime connection reply could not be read.",
    });
  });

  it("rejects a missing Lab Worker URL before signaling", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      signalRealtimeCall({
        agentInput: createInterviewConversationInput("  Ask why  "),
        endpointBaseUrl: "",
        offerSdp: "v=0",
        fetchImpl,
      }),
    ).rejects.toThrow("Set VITE_LAB_WORKER_URL before starting a live Interview.");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() =>
      buildRuntimeEventsUrl("", "abc123", "rtc_u1_Dm0cLlND6egD2Zfd19qs8", 60_000),
    ).toThrow("Set VITE_LAB_WORKER_URL before opening sideband control.");
    expect(() => buildRuntimeCloseUrl("", "abc123")).toThrow(
      "Set VITE_LAB_WORKER_URL before ending a live Interview.",
    );
    expect(() => buildRuntimePresenceUrl("", "abc123")).toThrow(
      "Set VITE_LAB_WORKER_URL before sending runtime presence.",
    );
  });

  it("rejects invalid sideband durations instead of falling back to a default", () => {
    expect(() => buildRuntimeEventsUrl("http://127.0.0.1:8795", "abc123", "rtc_123", 0)).toThrow(
      "Realtime sideband duration must be a positive finite integer.",
    );
  });

  it("extracts the OpenAI provider call ID from the Location header shape proven in Spike 0003", () => {
    expect(getProviderCallId("/v1/realtime/calls/rtc_u1_Dm0cLlND6egD2Zfd19qs8")).toBe(
      "rtc_u1_Dm0cLlND6egD2Zfd19qs8",
    );
  });

  it("rejects non-Realtime call IDs instead of persisting unrelated provider identifiers", () => {
    expect(getProviderCallId("/v1/realtime/calls/sess_not_a_call")).toBeNull();
  });

  it("reports Runtime Worker binding failures as actionable setup errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: "runtime_worker_unavailable",
          reason: "service_binding_unavailable",
          message: "Runtime Worker is not reachable through the RUNTIME_WORKER service binding.",
        },
        {
          status: 503,
          headers: {
            [LAB_RUN_ID_HEADER]: "lab_123",
            [LAB_RUN_STARTED_AT_HEADER]: "1700000000000",
          },
        },
      ),
    );

    await expect(
      signalRealtimeCall({
        agentInput: createInterviewConversationInput("  Ask why  "),
        endpointBaseUrl: "http://127.0.0.1:8795",
        offerSdp: "offer-sdp",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "RealtimeCallError",
      code: "runtime_worker_unavailable",
      reason: "service_binding_unavailable",
      runIdentity: {
        runId: "lab_123",
        startedAt: 1_700_000_000_000,
      },
      message: RUNTIME_WORKER_UNAVAILABLE_MESSAGE,
    } satisfies Partial<RealtimeCallError>);
  });

  it("requests Runtime Controller close through the Lab Worker runtime control path", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));

    await expect(
      requestRuntimeClose({
        endpointBaseUrl: "http://127.0.0.1:8795",
        runId: "abc123",
        timeoutMs: 4_000,
        endReason: "participant_stopped",
        microphoneStoppedAt: 1_700_000_001_234,
        finalTurnFlush: {
          status: "sidebandClosed",
          inputCommitSent: true,
          completionReviewStatus: "clean",
          debugText: "Final turn evidence was retained.",
        },
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      debugText: "Requested controller close for abc123.",
      completion: null,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8795/_api/runtime/runs/abc123/complete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          endReason: "participant_stopped",
          microphoneStoppedAt: 1_700_000_001_234,
          finalTurnFlush: {
            status: "sidebandClosed",
            inputCommitSent: true,
            completionReviewStatus: "clean",
            debugText: "Final turn evidence was retained.",
          },
        }),
        signal: readVitestAsymmetricMatcher(expect.any(AbortSignal)),
      },
    );
  });

  it("projects a terminal current close response without losing warnings or turn count", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        completion: {
          runId: "abc123",
          endedAt: 1_700_000_030_000,
          endReason: "participant_stopped",
          warnings: ["session_close_unconfirmed"],
          transcriptSnapshot: {
            revision: 2,
            digest: `sha256:${"b".repeat(64)}`,
            turnCount: 4,
          },
        },
      }),
    );

    await expect(
      requestRuntimeClose({
        endpointBaseUrl: "http://127.0.0.1:8795",
        runId: "abc123",
        timeoutMs: 4_000,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      debugText: "Requested controller close for abc123.",
      completion: {
        endedAt: 1_700_000_030_000,
        endReason: "participant_stopped",
        completionReviewStatus: "warning",
        transcriptTurnCount: 4,
        completionDebugText:
          "Runtime Controller completed with warning(s): session_close_unconfirmed.",
      },
    });
  });

  it("keeps malformed optional completion fields out of the owned projection", () => {
    expect(
      readRuntimeCompletionPayload({
        completion: {
          endedAt: "invalid",
          endReason: "participant_stopped",
          warnings: ["session_close_unconfirmed", 42],
          transcriptSnapshot: { turnCount: "invalid" },
          callerSelected: true,
        },
        callerEnvelopeField: true,
      }),
    ).toEqual({
      endReason: "participant_stopped",
      completionReviewStatus: "warning",
      completionDebugText:
        "Runtime Controller completed with warning(s): session_close_unconfirmed.",
    });
  });

  it("does not expose inherited completion fields outside the owned contract", () => {
    class RuntimeCompletionWithInheritedField {
      readonly endedAt = 1_700_000_030_000;
    }
    Object.defineProperty(RuntimeCompletionWithInheritedField.prototype, "providerSecret", {
      enumerable: true,
      value: "must-not-escape",
    });

    expect(
      readRuntimeCompletionPayload({
        completion: new RuntimeCompletionWithInheritedField(),
      }),
    ).toEqual({
      endedAt: 1_700_000_030_000,
      completionReviewStatus: "clean",
    });
  });

  it("keeps runtime close failures as warning-ready results", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: "runtime_close_failed",
        },
        {
          status: 502,
        },
      ),
    );

    await expect(
      requestRuntimeClose({
        endpointBaseUrl: "http://127.0.0.1:8795",
        runId: "abc123",
        timeoutMs: 4_000,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 502,
      code: "runtime_close_failed",
      debugText: "Runtime close returned 502 (runtime_close_failed).",
    });
  });

  it("sends browser presence heartbeats to the Lab Worker runtime path", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));

    await expect(
      sendRuntimePresence({
        endpointBaseUrl: "http://127.0.0.1:8795",
        runId: "abc123",
        mediaPresent: true,
        timeoutMs: 3_000,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8795/_api/runtime/presence?runId=abc123",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mediaPresent: true,
        }),
        signal: readVitestAsymmetricMatcher(expect.any(AbortSignal)),
      },
    );
  });
});
