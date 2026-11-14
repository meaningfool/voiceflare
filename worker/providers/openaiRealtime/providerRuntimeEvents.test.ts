import { describe, expect, it } from "vitest";

import { compactRealtimeEventPayload } from "./providerRuntimeEvents.ts";

describe("Cloudflare sideband Runtime Events", () => {
  it("records reported response output tokens with the response identity", () => {
    const payload = compactRealtimeEventPayload({
      type: "response.done",
      response: { id: "resp_42", usage: { output_tokens: 87 } },
    });
    expect(payload).toMatchObject({ responseId: "resp_42", response: { outputTokens: 87 } });
    expect(JSON.stringify(payload)).not.toContain("input_tokens");
    expect(
      compactRealtimeEventPayload({
        type: "response.done",
        response: { id: "resp_43", usage: { output_tokens: -1 } },
      }),
    ).not.toHaveProperty("response.outputTokens");
  });
  it("omits transcript and audio deltas from Runtime Event diagnostics", () => {
    expect(
      compactRealtimeEventPayload({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item_participant_1",
        delta: "The hallway track",
      }),
    ).toEqual({
      providerEventType: "conversation.item.input_audio_transcription.delta",
      source: "provider",
      provider: "openai_realtime",
      itemId: "item_participant_1",
    });

    expect(
      compactRealtimeEventPayload({
        type: "response.audio.delta",
        item_id: "item_agent_1",
        delta: "base64-audio-secret-sk-test",
      }),
    ).toEqual({
      providerEventType: "response.audio.delta",
      source: "provider",
      provider: "openai_realtime",
      itemId: "item_agent_1",
    });
  });

  it("keeps compact provider session summaries inside Runtime Event payloads", () => {
    expect(
      compactRealtimeEventPayload({
        type: "session.updated",
        session: {
          model: "gpt-realtime-2",
          reasoning: {
            effort: "medium",
          },
          audio: {
            input: {
              noise_reduction: {
                type: "far_field",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.65,
                create_response: true,
                interrupt_response: false,
              },
            },
            output: {
              voice: "marin",
            },
          },
        },
      }),
    ).toEqual({
      providerEventType: "session.updated",
      source: "provider",
      provider: "openai_realtime",
      session: {
        model: "gpt-realtime-2",
        voice: "marin",
        reasoningEffort: "medium",
        inputNoiseReduction: {
          type: "far_field",
        },
        turnDetection: {
          type: "server_vad",
          threshold: 0.65,
          createResponse: true,
          interruptResponse: false,
        },
      },
    });
  });

  it("redacts secret-looking values and omits HTTP-shaped request data", () => {
    const payloadJson = JSON.stringify(
      compactRealtimeEventPayload({
        type: "error",
        request: {
          headers: {
            Authorization: "Bearer sk-test-secret",
          },
        },
        error: {
          type: "server_error",
          code: "provider_failed",
          message: "OpenAI key sk-test-secret failed",
          stack: "stack trace",
        },
      }),
    );

    expect(payloadJson).toContain("sk-redacted");
    expect(payloadJson).not.toContain("sk-test-secret");
    expect(payloadJson).not.toContain("Authorization");
    expect(payloadJson).not.toContain("stack trace");
  });
});
