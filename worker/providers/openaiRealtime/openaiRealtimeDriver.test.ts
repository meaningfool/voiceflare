import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  openAiRealtimeDriver,
  readProviderHangupTimeoutMs,
  RealtimeDriver,
  type RealtimeCallRequest,
  type RealtimeHangupRequest,
  type RealtimeProviderDriver,
  type RealtimeSidebandRequest,
} from "./openaiRealtimeDriver.ts";
import { openAiDriverOver } from "./testing/testDriver.ts";
import type { RealtimeEndingCommand } from "./providerOperations.ts";
import {
  composeRealtimeSession,
  prepareRealtimeSettings,
  type ReasoningEffort,
} from "./preparedModelSession.ts";
import { providerFailureText } from "../../runtime/providerOutcomes.ts";

/** A session prepared through the kit, with one literal prompt and one tool. */
function preparedSession(
  input: Readonly<{ runId: string; instructions: string; reasoningEffort?: ReasoningEffort }>,
) {
  return composeRealtimeSession(
    input.runId,
    {
      instructions: { kind: "literal", text: input.instructions },
      operationalInstructions: "",
      tools: [
        {
          type: "function",
          name: "finish_interview",
          description: "Sample finish description.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    },
    prepareRealtimeSettings({ reasoningEffort: input.reasoningEffort ?? null }),
  );
}

/** Runs one operation of OpenAI's driver, through its service, on `transport`. */
function through<A>(
  transport: typeof fetch | undefined,
  use: (driver: RealtimeProviderDriver) => Effect.Effect<A>,
  signal?: AbortSignal,
): Promise<A> {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* use(yield* RealtimeDriver);
      }),
      openAiRealtimeDriver(transport),
    ),
    signal === undefined ? undefined : { signal },
  );
}

function createCall({
  fetchImpl,
  ...input
}: RealtimeCallRequest & Readonly<{ fetchImpl?: typeof fetch }>) {
  return through(fetchImpl, (driver) => driver.createCall(input));
}

/** The side connection; aborting `signal` interrupts it. */
function connectSideband({
  fetchImpl,
  signal,
  ...input
}: RealtimeSidebandRequest & Readonly<{ fetchImpl?: typeof fetch; signal?: AbortSignal }>) {
  return through(fetchImpl, (driver) => driver.connectSideband(input), signal);
}

function hangUp({
  fetchImpl,
  ...input
}: RealtimeHangupRequest & Readonly<{ fetchImpl?: typeof fetch }>) {
  return through(fetchImpl, (driver) => driver.hangUp(input));
}

/** OpenAI's driver, for its synchronous operations. */
const openAi = openAiDriverOver();

describe("OpenAI Realtime provider driver", () => {
  it("resolves the provider hangup timeout setting at ingress", () => {
    expect(readProviderHangupTimeoutMs(12.9)).toBe(12);
    expect(readProviderHangupTimeoutMs(" 24.9 ")).toBe(24);
    expect(readProviderHangupTimeoutMs(undefined)).toBe(8_000);
    expect(readProviderHangupTimeoutMs("not-a-timeout")).toBe(8_000);
    expect(readProviderHangupTimeoutMs({ timeoutMs: 100 })).toBe(8_000);
  });

  it("normalizes raw provider events into the Runtime event contract", () => {
    expect(
      openAi.normalizeEvent(
        JSON.stringify({
          type: "response.output_audio_transcript.done",
          response_id: "resp_agent_1",
          item_id: "item_agent_1",
          output_index: 0,
          content_index: 0,
          transcript: "  Thank you for sharing your feedback.  ",
        }),
      ),
    ).toMatchObject({
      type: "response.output_audio_transcript.done",
      toolInvocations: [],
      error: null,
      diagnosticSummary: {
        type: "response.output_audio_transcript.done",
        item_id: "item_agent_1",
        response_id: "resp_agent_1",
      },
      runtimeEventPayload: {
        providerEventType: "response.output_audio_transcript.done",
        source: "provider",
        provider: "openai_realtime",
        itemId: "item_agent_1",
        responseId: "resp_agent_1",
        outputIndex: 0,
        contentIndex: 0,
      },
    });

    expect(
      openAi.normalizeEvent(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "resp_finish",
            output: [
              {
                id: "item_finish",
                type: "function_call",
                name: "finish_interview",
                call_id: "call_finish",
              },
            ],
          },
        }),
      ).toolInvocations,
    ).toEqual([
      {
        type: "response.done",
        toolName: "finish_interview",
        callId: "call_finish",
        itemId: "item_finish",
        responseId: "resp_finish",
      },
    ]);

    expect(
      openAi.normalizeEvent(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "resp_incomplete_finish",
            output: [{ type: "function_call", name: "finish_interview" }],
          },
        }),
      ).toolInvocations,
    ).toEqual([
      { type: "response.done", toolName: "finish_interview", responseId: "resp_incomplete_finish" },
    ]);

    expect(
      openAi.normalizeEvent(
        JSON.stringify({
          type: "error",
          error: {
            code: "input_audio_buffer_commit_empty",
            message: "Audio buffer was empty.",
          },
        }),
      ).error,
    ).toEqual({
      message: "Audio buffer was empty.",
      code: "input_audio_buffer_commit_empty",
      reportAsDegradation: false,
    });
  });

  it("preserves final-text mapping when all provider events are observed, and Lab's narrower receipt mode", () => {
    const input = { sequence: 12, observedAt: 1_700_000_004_000, observeAllProviderEvents: true };
    const raw = JSON.stringify({
      type: "response.output_text.done",
      event_id: "text-event",
      response_id: "response-final",
      item_id: "item-final",
      text: "  Final text.  ",
    });
    expect(openAi.normalizeRuntimeObservation(raw, input)).toEqual({
      kind: "agent_transcript_finalized",
      generation: 1,
      sequence: 12,
      observedAt: 1_700_000_004_000,
      providerEventId: "text-event",
      responseId: "response-final",
      itemId: "item-final",
      text: "  Final text.  ",
    });
    expect(
      openAi.normalizeRuntimeObservation(raw, {
        ...input,
        observeAllProviderEvents: false,
      }),
    ).toBeNull();
    for (const malformed of ["{invalid", new ArrayBuffer(12), JSON.stringify({ type: "" })]) {
      expect(openAi.normalizeRuntimeObservation(malformed, input)).toBeNull();
    }
  });

  it("maps a prepared session without adding provider defaults", async () => {
    const session = preparedSession({
      runId: "run_123",
      instructions: "Prepared instructions",
      reasoningEffort: "medium",
    });
    const fetchImpl: typeof fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = init?.body;
      if (!(body instanceof FormData)) {
        throw new Error("Expected provider session FormData.");
      }

      const providerSessionJson = body.get("session");
      if (typeof providerSessionJson !== "string") {
        throw new Error("Expected a serialized provider session.");
      }

      const providerSession: unknown = JSON.parse(providerSessionJson);
      if (!isRecord(providerSession)) {
        throw new Error("Expected a provider session object.");
      }

      expect(providerSession).toMatchObject({
        model: "gpt-realtime-2.1",
        reasoning: { effort: "medium" },
        output_modalities: ["audio"],
      });
      expect(providerSession.instructions).toContain("Prepared instructions");
      expect(providerSession).not.toHaveProperty("temperature");

      return new Response("answer-sdp", {
        status: 201,
        headers: {
          "Content-Type": "application/vnd.example.sdp",
          Location: "https://api.openai.com/v1/realtime/calls/rtc_provider_call",
          "x-request-id": "req_provider_call",
        },
      });
    });

    await expect(
      createCall({
        apiKey: "sk-test-secret",
        sdp: "v=0",
        session,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        status: 201,
        answerSdp: "answer-sdp",
        responseContentType: "application/vnd.example.sdp",
        sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_provider_call",
        sessionId: "rtc_provider_call",
        upstreamRequestId: "req_provider_call",
      },
    });
  });

  it("reports a valid provider call identity before the answer body settles", async () => {
    const answer = acceptanceDeferred<string>();
    const response = new Response(null, {
      status: 201,
      headers: {
        "Content-Type": "application/sdp",
        Location: "https://api.openai.com/v1/realtime/calls/rtc_early_identity",
        "x-request-id": "req_early_identity",
      },
    });
    vi.spyOn(response, "text").mockImplementation(() => answer.promise);
    const onCallIdentified = vi.fn(async () => undefined);

    const result = createCall({
      apiKey: "sk-test-secret",
      sdp: "v=0",
      session: preparedSession({
        runId: "run_123",
        instructions: "Prepared instructions",
      }),
      fetchImpl: vi.fn(async () => response),
      onCallIdentified,
    });

    await vi.waitFor(() => expect(onCallIdentified).toHaveBeenCalledOnce());
    expect(onCallIdentified).toHaveBeenCalledWith({
      status: 201,
      responseContentType: "application/sdp",
      sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_early_identity",
      sessionId: "rtc_early_identity",
      upstreamRequestId: "req_early_identity",
    });
    answer.resolve("answer-sdp");
    await expect(result).resolves.toMatchObject({
      ok: true,
      value: { sessionId: "rtc_early_identity", answerSdp: "answer-sdp" },
    });
  });

  it("retains early call identity but stops waiting for the answer at the startup deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const response = new Response(null, {
      status: 201,
      headers: {
        "Content-Type": "application/sdp",
        Location: "https://api.openai.com/v1/realtime/calls/rtc_deadline_identity",
      },
    });
    vi.spyOn(response, "text").mockImplementation(() => new Promise<never>(() => undefined));
    let requestSignal: AbortSignal | null = null;
    const onCallIdentified = vi.fn(async () => undefined);

    const result = createCall({
      apiKey: "sk-test-secret",
      sdp: "v=0",
      session: preparedSession({
        runId: "run_123",
        instructions: "Prepared instructions",
      }),
      deadlineAt: 1_500,
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? null;
        return response;
      }),
      onCallIdentified,
    });

    await vi.waitFor(() => expect(onCallIdentified).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({
      ok: false,
      failure: { code: "provider_call_response_read_failed" },
    });
    const readRequestAborted = () => requestSignal?.aborted;
    expect(readRequestAborted()).toBe(true);
    vi.useRealTimers();
  });

  it("retains the reported identity when reading the answer body fails", async () => {
    const response = new Response(null, {
      status: 201,
      headers: {
        Location: "https://api.openai.com/v1/realtime/calls/rtc_failed_answer",
        "x-request-id": "req_failed_answer",
      },
    });
    vi.spyOn(response, "text").mockRejectedValue(new Error("response body lost"));
    const onCallIdentified = vi.fn(async () => undefined);

    await expect(
      createCall({
        apiKey: "sk-test-secret",
        sdp: "v=0",
        session: preparedSession({
          runId: "run_123",
          instructions: "Prepared instructions",
        }),
        fetchImpl: vi.fn(async () => response),
        onCallIdentified,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: {
        code: "provider_call_response_read_failed",
        requestId: "req_failed_answer",
      },
    });
    expect(onCallIdentified).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "rtc_failed_answer" }),
    );
  });

  it("returns compact secret-safe typed outcomes for provider transport failures", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new Error("Bearer sk-test-secret should not escape");
    });

    const result = await createCall({
      apiKey: "sk-test-secret",
      sdp: "v=0",
      session: preparedSession({
        runId: "run_123",
        instructions: "Prepared instructions",
      }),
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "call_creation",
        code: "provider_call_request_failed",
        retryable: true,
      },
    });
    expect(result.ok ? [] : Object.keys(result.failure)).toEqual([
      "kind",
      "stage",
      "code",
      "retryable",
    ]);
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("does not carry provider-controlled call failure bodies into typed outcomes", async () => {
    const distinctivePrompt = "Ask the participant about confidential launch plans";
    const result = await createCall({
      apiKey: "sk-test-secret",
      sdp: "v=0",
      session: preparedSession({
        runId: "run_123",
        instructions: distinctivePrompt,
      }),
      fetchImpl: vi.fn(
        async () =>
          new Response(`Provider rejected instructions: ${distinctivePrompt}`, {
            status: 503,
            headers: { "x-request-id": "req_call_failure" },
          }),
      ),
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "call_creation",
        code: "provider_call_http_503",
        providerStatus: 503,
        requestId: "req_call_failure",
        retryable: true,
      },
    });
    expect(result.ok ? [] : Object.keys(result.failure)).toEqual([
      "kind",
      "stage",
      "code",
      "providerStatus",
      "requestId",
      "retryable",
    ]);
    expect(JSON.stringify(result)).not.toContain(distinctivePrompt);
  });

  it("normalizes sideband setup failures after bounded call-id retries", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "call_id_not_found", secret: "ek_test_secret" }), {
          status: 404,
          headers: { "x-request-id": "req_sideband" },
        }),
    );
    const events: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pending = connectSideband({
      callId: "rtc_provider_call",
      apiKey: "sk-test-secret",
      emit: (event, data) => events.push({ event, data }),
      fetchImpl,
    });
    // Without a deadline the attempts are retried for 75 s.
    await vi.advanceTimersByTimeAsync(75_000);
    const result = await pending;
    vi.useRealTimers();

    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "session_setup",
        code: "sideband_call_id_not_found",
        providerStatus: 404,
        requestId: "req_sideband",
        retryable: true,
      },
    });
    expect(vi.mocked(fetchImpl).mock.calls.length).toBeGreaterThan(1);
    expect(events.map(({ event }) => event)).toContain("sideband.connect_attempt_rejected");
    expect(JSON.stringify(events)).not.toContain("ek_test_secret");
    const rejectedEvent = events.find(({ event }) => event === "sideband.connect_attempt_rejected");
    expect(rejectedEvent?.data).not.toHaveProperty("body");
    expect(result.ok ? "" : providerFailureText(result.failure)).toBe(
      "session_setup:sideband_call_id_not_found status=404 requestId=req_sideband",
    );
    expect(result.ok ? [] : Object.keys(result.failure)).toEqual([
      "kind",
      "stage",
      "code",
      "providerStatus",
      "requestId",
      "retryable",
    ]);
  });

  it("honors a Runtime finalization deadline while retrying sideband setup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "call_id_not_found" }), {
          status: 404,
        }),
    );
    try {
      let settled = false;
      const result = connectSideband({
        callId: "rtc_provider_call",
        apiKey: "sk-test-secret",
        emit: () => undefined,
        fetchImpl,
        retryDeadlineAt: 5_000,
      }).finally(() => {
        settled = true;
      });

      // Attempts at 0, 2 s and 4 s; the last pause is cut to the 1 s left before the deadline.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        ok: false,
        failure: { code: "sideband_call_id_not_found" },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an individual sideband connection attempt by its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let requestSignal: AbortSignal | null = null;
    const fetchImpl: typeof fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? null;
          requestSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const result = connectSideband({
      callId: "rtc_provider_call",
      apiKey: "sk-test-secret",
      emit: () => undefined,
      fetchImpl,
      retryDeadlineAt: 1_500,
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toMatchObject({
      ok: false,
      failure: { code: "sideband_connect_failed", retryable: false },
    });
    const readRequestAborted = () => requestSignal?.aborted;
    expect(readRequestAborted()).toBe(true);
    vi.useRealTimers();
  });

  it.each(["accept", "accept_failure"] as const)(
    "cancels acquisition and releases an ignored-abort late upgrade during %s",
    async (trigger) => {
      const controller = new AbortController();
      const socket = {
        readyState: 1,
        accept: vi.fn(() => {
          if (trigger === "accept_failure") throw new Error("native_late_accept_failed");
        }),
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      };
      let finish: (response: Response) => void = () => {};
      let requestSignal: AbortSignal | null | undefined;
      const reply = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const operation = connectSideband({
        callId: "rtc_cancelled",
        apiKey: "test-key",
        emit: () => {},
        signal: controller.signal,
        fetchImpl: async (_url, init) => {
          requestSignal = init?.signal;
          return reply;
        },
      });
      const rejected = expect(operation).rejects.toThrow();
      await vi.waitFor(() => expect(requestSignal).toBeDefined());
      controller.abort();
      await rejected;
      expect(requestSignal?.aborted).toBe(true);
      const response = new Response(null);
      Object.defineProperty(response, "webSocket", { value: socket });
      finish(response);
      await vi.waitFor(() =>
        expect(socket.close).toHaveBeenCalledWith(1000, "sideband_acquisition_cancelled"),
      );
      expect(socket.accept).toHaveBeenCalledOnce();
    },
  );

  it("cancels a pending retry without attempting the call again", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("call_id_not_found", { status: 404 }));
    const operation = connectSideband({
      callId: "rtc_retry_cancelled",
      apiKey: "test-key",
      emit: () => {},
      signal: controller.signal,
      fetchImpl,
    });
    const rejected = expect(operation).rejects.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("closes an upgrade that arrives at the attempt's deadline, before the attempt takes it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn(),
        close: vi.fn(),
      };
      const reply = acceptanceDeferred<Response>();
      const fetchImpl: typeof fetch = vi.fn(() => reply.promise);
      const result = connectSideband({
        callId: "rtc_upgrade_at_deadline",
        apiKey: "test-key",
        emit: () => {},
        fetchImpl,
        retryDeadlineAt: 1_500,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledOnce();
      // The upgrade arrives at the deadline, before the deadline's timer runs.
      vi.setSystemTime(1_500);
      const response = new Response(null);
      Object.defineProperty(response, "webSocket", { value: socket });
      reply.resolve(response);
      await expect(result).resolves.toEqual({
        ok: false,
        failure: {
          kind: "provider_failure",
          stage: "session_setup",
          code: "sideband_connect_failed",
          retryable: false,
        },
      });
      expect(socket.close.mock.calls).toEqual([[1000, "sideband_acquisition_cancelled"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an upgrade whose optional listener-release capability violates the consumer contract", async () => {
    const response = new Response(null);
    Object.defineProperty(response, "webSocket", {
      value: {
        readyState: 1,
        accept: () => {},
        send: () => {},
        addEventListener: () => {},
        close: () => {},
        removeEventListener: 42,
      },
    });
    await expect(
      connectSideband({
        callId: "rtc_invalid_socket",
        apiKey: "test-key",
        emit: () => {},
        fetchImpl: async () => response,
      }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "session_setup",
        code: "sideband_connect_rejected",
        providerStatus: 200,
        retryable: false,
      },
    });
  });

  it("releases an accepted sideband socket when its admission diagnostic throws", async () => {
    const socket = {
      readyState: 1,
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    const response = new Response(null);
    Object.defineProperty(response, "webSocket", { value: socket });
    const fetchImpl = vi.fn(async () => response);
    await expect(
      connectSideband({
        callId: "rtc_admission_failed",
        apiKey: "test-key",
        emit: (event) => {
          if (event === "sideband.connect_attempt_accepted")
            throw new Error("admission_diagnostic_failed");
        },
        fetchImpl,
      }),
    ).rejects.toThrow("admission_diagnostic_failed");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(1000, "sideband_acquisition_failed");
  });

  it("accepts and returns a provider sideband socket", async () => {
    const socket = {
      readyState: 1,
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    const response = new Response(null, {
      status: 200,
      headers: { "x-request-id": "req_sideband_connected" },
    });
    Object.defineProperty(response, "webSocket", { value: socket });
    const events: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];

    const result = await connectSideband({
      callId: "rtc_provider_call",
      apiKey: "sk-test-secret",
      emit: (event, data) => events.push({ event, data }),
      fetchImpl: vi.fn(async () => response),
    });

    expect(result).toEqual({ ok: true, value: socket });
    expect(socket.accept).toHaveBeenCalledTimes(1);
    const acceptedEvent = events.find(({ event }) => event === "sideband.connect_attempt_accepted");
    expect(acceptedEvent?.data).toMatchObject({
      attemptNumber: 1,
      upstreamRequestId: "req_sideband_connected",
    });
  });

  it("admits late native identity once after the caller cutoff without reading late SDP", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const headers = acceptanceDeferred<Response>();
    const response = new Response("late-answer", {
      status: 201,
      headers: {
        Location: "https://api.openai.com/v1/realtime/calls/rtc_late_headers",
      },
    });
    const read = vi.spyOn(response, "text");
    const identify = vi.fn(async () => undefined);
    const retained: Promise<void>[] = [];
    const fetchImpl: typeof fetch = vi.fn(() => headers.promise);
    const result = createCall({
      apiKey: "test",
      sdp: "offer",
      session: preparedSession({
        runId: "late",
        instructions: "Interview",
      }),
      deadlineAt: 1_010,
      fetchImpl,
      onCallIdentified: identify,
      retainCallIdentity: (task) => retained.push(task),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({
      ok: false,
      failure: { code: "provider_call_request_failed" },
    });
    expect(identify).not.toHaveBeenCalled();
    headers.resolve(response);
    await Promise.all(retained);
    expect(identify.mock.calls).toEqual([
      [expect.objectContaining({ sessionId: "rtc_late_headers" })],
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("keeps the original cutoff while identity persistence is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const persistence = acceptanceDeferred<void>();
    const response = new Response("answer", {
      status: 201,
      headers: {
        Location: "https://api.openai.com/v1/realtime/calls/rtc_pending_persistence",
      },
    });
    const read = vi.spyOn(response, "text");
    const identify = vi.fn(() => persistence.promise);
    const retained: Promise<void>[] = [];
    const result = createCall({
      apiKey: "test",
      sdp: "offer",
      session: preparedSession({
        runId: "pending",
        instructions: "Interview",
      }),
      deadlineAt: 1_010,
      fetchImpl: vi.fn(async () => response),
      onCallIdentified: identify,
      retainCallIdentity: (task) => retained.push(task),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({
      ok: false,
      failure: { code: "provider_call_response_read_failed" },
    });
    persistence.resolve();
    await Promise.all(retained);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("dispatches neither expired creates nor replacement mutations after uncertain hangup", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new TypeError("lost reply");
    });
    expect(
      await createCall({
        apiKey: "test",
        sdp: "offer",
        session: preparedSession({
          runId: "expired",
          instructions: "Interview",
        }),
        deadlineAt: Date.now() - 1,
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, failure: { code: "provider_call_request_failed" } });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(await hangUp({ apiKey: "test", callId: "rtc_once", fetchImpl })).toMatchObject({
      ok: false,
      failure: { code: "session_release_uncertain" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("finishes hangup from headers with an unused stalled body", async () => {
    const response = new Response(new ReadableStream({ start() {} }), { status: 200 });
    const read = vi.spyOn(response, "text");
    expect(
      await hangUp({
        apiKey: "test",
        callId: "rtc_headers",
        fetchImpl: vi.fn(async () => response),
      }),
    ).toEqual({ ok: true, value: { status: 200, upstreamRequestId: null } });
    expect(read).not.toHaveBeenCalled();
  });

  it("bounds an uncancellable hangup wait and never redispatches after its late reply", async () => {
    vi.useFakeTimers();
    const response = acceptanceDeferred<Response>();
    const fetchImpl: typeof fetch = vi.fn(() => response.promise);
    const result = hangUp({
      apiKey: "test",
      callId: "rtc_late_hangup",
      timeoutMs: 10,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({
      ok: false,
      failure: { code: "session_release_timed_out", timeoutMs: 10 },
    });
    response.resolve(new Response(null, { status: 200 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("rejects late hangup headers even when the timer has not been delivered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const headers = acceptanceDeferred<Response>();
    const fetchImpl: typeof fetch = vi.fn(() => headers.promise);
    const result = hangUp({
      apiKey: "test",
      callId: "rtc_original_cutoff",
      timeoutMs: 10,
      fetchImpl,
    });
    vi.setSystemTime(1_020);
    headers.resolve(new Response(null, { status: 200 }));
    expect(await result).toMatchObject({
      ok: false,
      failure: { code: "session_release_timed_out", timeoutMs: 10 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("normalizes hangup timeout outcomes", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const resultPromise = hangUp({
      apiKey: "sk-test-secret",
      callId: "rtc_provider_call",
      timeoutMs: 5,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "hangup",
        code: "session_release_timed_out",
        retryable: true,
        timeoutMs: 5,
      },
    });
    const result = await resultPromise;
    expect(result.ok ? [] : Object.keys(result.failure)).toEqual([
      "kind",
      "stage",
      "code",
      "retryable",
      "timeoutMs",
    ]);
    vi.useRealTimers();
  });

  it("classifies a hangup request without a response as uncertain", async () => {
    const result = await hangUp({
      apiKey: "sk-test-secret",
      callId: "rtc_provider_call",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("network connection reset");
      }),
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "hangup",
        code: "session_release_uncertain",
        retryable: true,
      },
    });
  });

  it("does not carry provider-controlled hangup bodies into typed outcomes", async () => {
    const result = await hangUp({
      apiKey: "sk-test-secret",
      callId: "rtc_provider_call",
      fetchImpl: vi.fn(
        async () =>
          new Response("Bearer sk-test-secret provider unavailable", {
            status: 503,
            headers: { "x-request-id": "req_hangup_failure" },
          }),
      ),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "hangup",
        code: "session_release_failed",
        providerStatus: 503,
        requestId: "req_hangup_failure",
        retryable: true,
      },
    });
    expect(result.ok ? "" : providerFailureText(result.failure)).toBe(
      "hangup:session_release_failed status=503 requestId=req_hangup_failure",
    );
    expect(result.ok ? [] : Object.keys(result.failure)).toEqual([
      "kind",
      "stage",
      "code",
      "providerStatus",
      "requestId",
      "retryable",
    ]);
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("keeps a generic hangup 404 as an unconfirmed provider failure", async () => {
    const result = await hangUp({
      apiKey: "sk-test-secret",
      callId: "rtc_provider_call",
      fetchImpl: vi.fn(
        async () =>
          new Response("not found", {
            status: 404,
            headers: { "x-request-id": "req_hangup_not_found" },
          }),
      ),
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "hangup",
        code: "session_release_failed",
        providerStatus: 404,
        requestId: "req_hangup_not_found",
        retryable: false,
      },
    });
  });

  it.each([
    [
      { kind: "disable_automatic_turns", commandId: "run:1" },
      '{"event_id":"run:1","type":"session.update","session":{"type":"realtime","audio":{"input":{"turn_detection":null}}}}',
    ],
    [
      { kind: "commit_input", commandId: "run:2" },
      '{"event_id":"run:2","type":"input_audio_buffer.commit"}',
    ],
    [
      { kind: "clear_input", commandId: "run:3" },
      '{"event_id":"run:3","type":"input_audio_buffer.clear"}',
    ],
    [
      { kind: "cancel_response", commandId: "run:4", responseId: "response_named" },
      '{"event_id":"run:4","type":"response.cancel","response_id":"response_named"}',
    ],
    [
      { kind: "clear_output", commandId: "run:5" },
      '{"event_id":"run:5","type":"output_audio_buffer.clear"}',
    ],
  ] satisfies readonly (readonly [RealtimeEndingCommand, string])[])(
    "encodes the selected finalization operation %j at the socket boundary",
    (operation, expectedWire) => {
      const socket = { send: vi.fn() };
      expect(openAi.sendFinalizationOperation({ socket, operation })).toEqual({
        ok: true,
        value: undefined,
      });
      expect(socket.send.mock.calls).toEqual([[expectedWire]]);
    },
  );

  it("retains transport failure when finalization socket dispatch throws", () => {
    const socket = {
      send: vi.fn(() => {
        throw new Error("connection_lost");
      }),
    };
    expect(
      openAi.sendFinalizationOperation({
        socket,
        operation: { kind: "commit_input", commandId: "run:2" },
      }),
    ).toEqual({
      ok: false,
      failure: {
        kind: "provider_failure",
        stage: "provider_command",
        code: "provider_command_send_failed",
        retryable: true,
      },
    });
    expect(socket.send.mock.calls).toEqual([
      ['{"event_id":"run:2","type":"input_audio_buffer.commit"}'],
    ]);
  });

  it("keeps per-response commands outside the prepared session", () => {
    const socket = { send: vi.fn() };
    const result = openAi.sendCommand({
      socket,
      command: { type: "response.create", event_id: "evt_initial" },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "response.create", event_id: "evt_initial" }),
    );
  });
});

interface RecordGuard {
  (value: unknown): value is Record<string, unknown>;
}

const isRecord: RecordGuard = (value): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

function acceptanceDeferred<Value>() {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value: Value) {
      if (resolve === undefined) throw new Error("promise_not_initialized");
      resolve(value);
    },
  };
}
