import { describe, expect, it } from "vitest";
import { selectInterviewModels } from "./preparedModelSession.ts";

import {
  normalizeProviderRealtimeEvent,
  normalizeProviderRuntimeObservation,
  parseRealtimeEvent,
} from "./providerEvents.ts";

describe("provider event ingress", () => {
  describe("wire ingress", () => {
    it("retains malformed, unsupported, and binary message behavior", () => {
      expect(normalizeProviderRealtimeEvent("{not-json")).toMatchObject({
        type: "unparseable_text",
        toolInvocations: [],
        error: null,
      });
      expect(
        normalizeProviderRuntimeObservation(
          JSON.stringify({ type: "response.output_audio.delta", delta: "base64-audio" }),
          1,
        ),
      ).toBeNull();
      expect(parseRealtimeEvent(new ArrayBuffer(12))).toEqual({
        type: "binary_message",
        byteLength: 12,
      });
      expect(parseRealtimeEvent({ size: 7 })).toEqual({
        type: "binary_message",
        byteLength: 7,
      });
      expect(parseRealtimeEvent({ byteLength: null, size: 7 })).toEqual({
        type: "binary_message",
        byteLength: 7,
      });
      expect(parseRealtimeEvent({ byteLength: Number.POSITIVE_INFINITY })).toEqual({
        type: "binary_message",
        byteLength: Number.POSITIVE_INFINITY,
      });
      expect(parseRealtimeEvent(42)).toEqual({
        type: "binary_message",
        byteLength: null,
      });
      expect(parseRealtimeEvent("1e400")).toBe(Number.POSITIVE_INFINITY);
      expect(Array.isArray(parseRealtimeEvent(`${"[".repeat(2_048)}0${"]".repeat(2_048)}`))).toBe(
        true,
      );
    });

    it.each([
      {},
      { type: 42, error: { message: 42, code: [] }, response: { output: [{}] } },
      {
        type: "response.function_call_arguments.done",
        call_id: 42,
        response_id: [],
        name: "finish_interview",
      },
    ])("keeps malformed consumer fields out of normalized owned values (%o)", (event) => {
      const normalized = normalizeProviderRealtimeEvent(JSON.stringify(event));
      expect(normalized.type).toBe(typeof event.type === "string" ? event.type : "unknown");
      expect(normalized.toolInvocations).toEqual(
        typeof event.type === "string" && event.type === "response.function_call_arguments.done"
          ? [{ type: event.type, toolName: "finish_interview" }]
          : [],
      );
      expect(normalized).not.toHaveProperty("transcriptObservation");
      expect(normalized.error).toBeNull();
      expect(normalized.diagnosticSummary).not.toHaveProperty("call_id");
      expect(normalized.runtimeEventPayload).not.toHaveProperty("callId");
    });

    it("excludes arbitrary raw keys and inherited required identities from the owned output", () => {
      const event = {
        type: "response.function_call_arguments.done",
        name: "finish_interview",
        call_id: "call",
        response_id: "response",
        unrelated: "secret",
        __proto__: { item_id: "inherited" },
      };
      const normalized = normalizeProviderRealtimeEvent(JSON.stringify(event));
      expect(normalized.toolInvocations).toEqual([
        {
          type: "response.function_call_arguments.done",
          toolName: "finish_interview",
          callId: "call",
          responseId: "response",
        },
      ]);
      expect(normalized.runtimeEventPayload).not.toHaveProperty("unrelated");
      expect(normalized.runtimeEventPayload).not.toHaveProperty("itemId");
      expect(normalizeProviderRealtimeEvent(event)).toMatchObject({
        type: "binary_message",
        toolInvocations: [],
        error: null,
      });
    });
  });

  it("omits absent optional provider error fields", () => {
    expect(normalizeProviderRealtimeEvent(JSON.stringify({ type: "error" })).error).toEqual({
      message: "OpenAI sideband provider error observed.",
      reportAsDegradation: true,
    });
  });

  it("preserves serialized provider event field order", () => {
    const { diagnosticSummary } = normalizeProviderRealtimeEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "response_1",
        item_id: "item_1",
        call_id: "call_1",
        name: "finish_interview",
      }),
    );

    expect(Object.keys(diagnosticSummary)).toEqual(["type", "item_id", "response_id"]);
  });
});

describe("provider Runtime observation normalization", () => {
  it("preserves the upstream event ID for replay deduplication", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          event_id: "event_stable_1",
          type: "response.created",
          response: { id: "response_1" },
        }),
        7,
      ),
    ).toMatchObject({
      kind: "reply_started",
      providerEventId: "event_stable_1",
      sequence: 7,
    });
  });

  it("does not invent a blank Transcript turn for empty final text", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_empty",
          transcript: "   ",
        }),
        1,
      ),
    ).toEqual({
      generation: 1,
      sequence: 1,
      kind: "participant_answer_transcribed",
      itemId: "item_empty",
      usage: [
        {
          status: "unavailable",
          componentRole: "speech_to_text",
          key: "speech_to_text:item_empty:unknown",
          pendingKey: "speech_to_text:item_empty",
        },
      ],
    });
  });

  it("preserves provider-final Transcript whitespace for snapshot identity", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_whitespace",
          transcript: "  exact final text\n",
        }),
        2,
      ),
    ).toMatchObject({
      kind: "participant_answer_transcribed",
      itemId: "item_whitespace",
      text: "  exact final text\n",
    });
  });

  it("keeps the provider error cause distinct from the provider event envelope", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          event_id: "provider_error_envelope",
          type: "error",
          error: {
            event_id: "client_command_that_failed",
            code: "invalid_request_error",
          },
        }),
        3,
      ),
    ).toMatchObject({
      kind: "session_error_observed",
      providerEventId: "provider_error_envelope",
      eventId: "client_command_that_failed",
      code: "invalid_request_error",
    });
  });

  it.each([undefined, 42, {}, "", " other-command "])(
    "reports an empty-input rejection as nothing to settle for the commit it names (%o)",
    (requestId) => {
      const data = JSON.stringify({
        type: "error",
        event_id: "envelope-command",
        error: {
          code: "input_audio_buffer_commit_empty",
          event_id: requestId,
          message: "No buffered audio",
          unrelated: "private",
        },
      });
      const observation = normalizeProviderRuntimeObservation(data, 9, true, 123);
      const order = {
        generation: 1,
        sequence: 9,
        observedAt: 123,
        providerEventId: "envelope-command",
      };
      // Without the commit it answers, the rejection settles nothing; the envelope is no command.
      expect(observation).toEqual(
        requestId === " other-command "
          ? { ...order, kind: "nothing_to_settle", commandId: " other-command " }
          : { ...order, kind: "session_error_observed", code: "input_audio_buffer_commit_empty" },
      );
      expect(normalizeProviderRealtimeEvent(data).error).toEqual({
        code: "input_audio_buffer_commit_empty",
        message: "No buffered audio",
        reportAsDegradation: false,
      });
      const expectedDiagnostic = {
        code: "input_audio_buffer_commit_empty",
        message: "No buffered audio",
      };
      expect(normalizeProviderRealtimeEvent(data).diagnosticSummary.error).toEqual(
        requestId === " other-command "
          ? { ...expectedDiagnostic, event_id: " other-command " }
          : expectedDiagnostic,
      );
    },
  );

  it.each(["input_audio_buffer_commit_empty_extra", "unknown", 42, null])(
    "does not infer empty input from another rejection code (%o)",
    (code) => {
      const data = JSON.stringify({ type: "error", error: { code, event_id: "command" } });
      expect(normalizeProviderRuntimeObservation(data, 10)).toMatchObject({
        kind: "session_error_observed",
        eventId: "command",
      });
      expect(normalizeProviderRealtimeEvent(data).error?.reportAsDegradation).toBe(true);
    },
  );

  it("does not give non-error events rejection meaning from nested fields", () => {
    const data = JSON.stringify({
      type: "rate_limits.updated",
      event_id: "envelope",
      error: { code: "input_audio_buffer_commit_empty", event_id: "command" },
    });
    expect(normalizeProviderRealtimeEvent(data).error).toBeNull();
    expect(normalizeProviderRealtimeEvent(data).diagnosticSummary.error).toEqual({
      code: "input_audio_buffer_commit_empty",
      event_id: "command",
    });
    expect(normalizeProviderRuntimeObservation(data, 11, true, 123)).toEqual({
      kind: "session_activity_observed",
      generation: 1,
      sequence: 11,
      observedAt: 123,
      at: 123,
      providerEventId: "envelope",
    });
  });

  it("observes provider traffic when all events are observed, without admitting diagnostic parser fallbacks", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({ event_id: "provider-rate", type: "rate_limits.updated" }),
        7,
        true,
      ),
    ).toMatchObject({
      kind: "session_activity_observed",
      sequence: 7,
      providerEventId: "provider-rate",
    });
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({ type: "response.output_audio.delta", delta: "audio" }),
        8,
        true,
      ),
    ).toMatchObject({ kind: "session_activity_observed", sequence: 8 });
    expect(normalizeProviderRuntimeObservation("{invalid", 9, true)).toBeNull();
    expect(normalizeProviderRuntimeObservation(new ArrayBuffer(12), 10, true)).toBeNull();
    expect(normalizeProviderRuntimeObservation(JSON.stringify({ type: "" }), 11, true)).toBeNull();
  });

  it("does not turn every output audio delta into a durable lifecycle observation", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          event_id: "audio_delta_1",
          type: "response.output_audio.delta",
          response_id: "response_1",
          delta: "base64-audio",
        }),
        4,
      ),
    ).toBeNull();
  });

  it.each(["completed", "cancelled", "failed", "incomplete"] as const)(
    "normalizes response.done usage for terminal status %s",
    (status) => {
      const observation = normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "response.done",
          response: { id: `response_${status}`, status, output: [], usage: realtimeUsage() },
        }),
        9,
        false,
        undefined,
        selectInterviewModels(),
      );
      expect(observation).toMatchObject({
        kind: status === "cancelled" ? "reply_cancelled" : "reply_generated",
        responseId: `response_${status}`,
      });
      if (observation?.kind !== "reply_generated" && observation?.kind !== "reply_cancelled")
        return;
      const [settled, ...others] = observation.usage ?? [];
      expect(others).toEqual([]);
      expect(settled).toMatchObject({
        status: "satisfied",
        key: `speech_to_speech:response_${status}`,
      });
      expect(settled?.status === "satisfied" ? settled.measurements : []).toContainEqual(
        expect.objectContaining({ measure: "output_audio", quantity: 3 }),
      );
    },
  );

  it("retains independent transcription usage and content identity", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "participant_1",
          content_index: 2,
          transcript: "Feedback",
          usage: {
            type: "tokens",
            total_tokens: 7,
            input_tokens: 5,
            output_tokens: 2,
            input_token_details: { audio_tokens: 5, text_tokens: 0 },
          },
        }),
        10,
        false,
        undefined,
        selectInterviewModels(),
      ),
    ).toMatchObject({
      kind: "participant_answer_transcribed",
      itemId: "participant_1",
      contentIndex: 2,
      usage: [{ status: "satisfied", key: "speech_to_text:participant_1:2" }],
    });
  });

  it.each([
    { type: "response.done", response: { status: "completed", usage: realtimeUsage() } },
    {
      type: "conversation.item.input_audio_transcription.completed",
      usage: {
        type: "tokens",
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        input_token_details: { audio_tokens: 0, text_tokens: 0 },
      },
    },
  ])(
    "retains an accounting gap when all events are observed and a terminal identity is missing",
    (event) => {
      expect(normalizeProviderRuntimeObservation(JSON.stringify(event), 11, true)).toMatchObject({
        kind: "session_activity_observed",
        usage: [{ status: "uncertain" }],
      });
    },
  );
});

function realtimeUsage() {
  return {
    total_tokens: 25,
    input_tokens: 20,
    output_tokens: 5,
    input_token_details: {
      text_tokens: 10,
      audio_tokens: 10,
      image_tokens: 0,
      cached_tokens: 7,
      cached_tokens_details: { text_tokens: 3, audio_tokens: 4, image_tokens: 0 },
    },
    output_token_details: { text_tokens: 2, audio_tokens: 3 },
  };
}

describe("closing response inventory at the provider JSON ingress", () => {
  it.each(["text", "output_text", "audio", "output_audio"])(
    "accepts final %s content in a successful terminal response when all events are observed, without changing Lab capture",
    (type) => {
      const content = type.endsWith("text")
        ? { type, text: "  Final closing text\n" }
        : { type, transcript: "  Final closing text\n" };
      const event = JSON.stringify({
        type: "response.done",
        response: {
          id: "closing",
          status: "completed",
          output: [{ id: "message", type: "message", role: "assistant", content: [content] }],
        },
      });
      expect(normalizeProviderRuntimeObservation(event, 1, true)).toMatchObject({
        transcriptItems: [{ itemId: "message", text: "  Final closing text\n" }],
      });
      expect(normalizeProviderRuntimeObservation(event, 1)).toMatchObject({
        transcriptItems: [{ itemId: "message" }],
      });
      expect(JSON.stringify(normalizeProviderRuntimeObservation(event, 1))).not.toContain(
        "Final closing text",
      );
    },
  );

  it.each(["cancelled", "failed", "incomplete", undefined])(
    "does not treat partial terminal content as final-text proof for status %s",
    (status) => {
      const observation = normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "closing",
            status,
            output: [
              {
                id: "message",
                type: "message",
                role: "assistant",
                content: [{ type: "output_audio", transcript: "Partial content" }],
              },
            ],
          },
        }),
        1,
        true,
      );
      expect(observation).toMatchObject({
        transcriptItems: [{ itemId: "message" }],
      });
      expect(JSON.stringify(observation)).not.toContain("Partial content");
    },
  );

  it("accepts final text events only when all events are observed, and retains empty final text as failed proof", () => {
    for (const text of ["Final text", "   ", 42, undefined]) {
      const event = JSON.stringify({
        type: "response.output_text.done",
        response_id: "closing",
        item_id: "message",
        text,
        extra: { secret: "discard" },
      });
      const observation = normalizeProviderRuntimeObservation(event, 1, true);
      expect(observation).toMatchObject({
        kind: "agent_transcript_finalized",
        responseId: "closing",
        itemId: "message",
      });
      if (text === "Final text") expect(observation).toHaveProperty("text", text);
      else expect(observation).not.toHaveProperty("text");
      expect(JSON.stringify(observation)).not.toContain("discard");
      expect(normalizeProviderRuntimeObservation(event, 1)).toBeNull();
    }
  });

  it("requires final text in every terminal content part", () => {
    for (const finalPart of [
      { type: "output_text", text: "Second part" },
      { type: "output_text" },
      { type: "output_audio", transcript: 42 },
      { type: "future_content", text: "Unknown part" },
    ]) {
      const observation = normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "closing",
            status: "completed",
            output: [
              {
                id: "message",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "First part" }, finalPart],
              },
            ],
          },
        }),
        1,
        true,
      );
      if (finalPart.text === "Second part")
        expect(observation).toMatchObject({
          transcriptItems: [{ text: "First part\nSecond part" }],
        });
      else expect(JSON.stringify(observation)).not.toContain("First part");
    }
  });

  it.each(
    [
      undefined,
      null,
      {},
      "output",
      [null],
      [{ type: "message", role: "assistant", content: [] }],
      [{ id: "message", type: "message", role: "assistant", content: [null] }],
      [
        {
          id: "message",
          type: "message",
          role: "assistant",
          content: [{ type: "future_content" }],
        },
      ],
      [{ id: "future", type: "future_item" }],
      [
        { id: "same", type: "function_call" },
        { id: "same", type: "function_call" },
      ],
    ].map((output) => ({ output })),
  )("does not certify missing or unrecognized output: %j", ({ output }) => {
    const observation = normalizeProviderRuntimeObservation(
      JSON.stringify({
        type: "response.done",
        response: { id: "closing", status: "completed", output },
      }),
      1,
      true,
    );
    expect(observation).not.toHaveProperty("transcriptInventoryComplete", true);
  });
  it.each(
    [
      [],
      [{ id: "tool", type: "function_call", name: "finish_interview", call_id: "call" }],
      [
        { id: "first", type: "message", role: "assistant", content: [{ type: "audio" }] },
        { id: "second", type: "message", role: "assistant", content: [{ type: "text" }] },
      ],
    ].map((output) => ({ output })),
  )("certifies a known complete inventory independently of final text: %j", ({ output }) => {
    const observation = normalizeProviderRuntimeObservation(
      JSON.stringify({
        type: "response.done",
        extra: true,
        response: { id: "closing", status: "completed", output, extra: { secret: "discard" } },
      }),
      1,
      true,
    );
    expect(observation).toMatchObject({ responseId: "closing", transcriptInventoryComplete: true });
    expect(JSON.stringify(observation)).not.toContain("discard");
    expect(JSON.stringify(observation)).not.toContain("extra");
  });
  it("retains inventory evidence on cancelled responses without treating tool arguments as an inventory", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "response.done",
          response: { id: "closing", status: "cancelled", output: [] },
        }),
        1,
        true,
      ),
    ).toMatchObject({ kind: "reply_cancelled", transcriptInventoryComplete: true });
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          name: "finish_interview",
          response_id: "closing",
          call_id: "call",
          arguments: "{}",
        }),
        1,
        true,
      ),
    ).not.toHaveProperty("transcriptInventoryComplete");
  });
});
