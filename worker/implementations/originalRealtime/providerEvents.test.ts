import { admitImplementation } from "../../runtime/admission/private/composition.ts";
import { interviewAgent } from "./implementation.ts";
import { interpretConversationTools } from "../../runtime/conversationObserve.ts";
import { describe, expect, it } from "vitest";

import { normalizeProviderRuntimeObservation as normalizeNativeObservation } from "../../providers/openaiRealtime/providerEvents.ts";
import { runtimeReport } from "../../providers/openaiRealtime/speech.ts";
import { selectInterviewModels } from "../../providers/openaiRealtime/preparedModelSession.ts";

/** What Original's finish_interview means once the Realtime kit decoded the provider event. */
describe("Original's finish_interview in decoded provider events", () => {
  it("correlates finish_interview to its own tool call in a multi-call response", () => {
    const observation = normalizeProviderRuntimeObservation(
      JSON.stringify({
        event_id: "event_multi_tool_response",
        type: "response.done",
        response: {
          id: "response_multi_tool",
          status: "completed",
          usage: realtimeUsage(),
          output: [
            {
              id: "item_other_tool",
              type: "function_call",
              name: "record_note",
              call_id: "call_other_tool",
            },
            {
              id: "item_finish_tool",
              type: "function_call",
              name: "finish_interview",
              call_id: "call_finish_tool",
            },
          ],
        },
      }),
      5,
    );
    expect(observation).toMatchObject({
      kind: "provider_finish_interview_observed",
      itemId: "item_finish_tool",
      responseId: "response_multi_tool",
      callId: "call_finish_tool",
      responseStatus: "completed",
      usage: [{ status: "satisfied", key: "speech_to_speech:response_multi_tool" }],
    });
    expect(observation?.kind).toBe("provider_finish_interview_observed");
    if (observation?.kind !== "provider_finish_interview_observed") return;
    expect(observation.transcriptItems).toContainEqual(
      expect.objectContaining({
        itemId: "item_finish_tool",
        responseId: "response_multi_tool",
      }),
    );
  });

  it("normalizes a direct finish tool completion only when both identities are present", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          event_id: "event_finish_arguments",
          type: "response.function_call_arguments.done",
          response_id: "  response_closing  ",
          item_id: "item_finish",
          call_id: "  call_finish  ",
          name: "finish_interview",
          arguments: "{}",
        }),
        6,
      ),
    ).toMatchObject({
      kind: "provider_finish_interview_observed",
      responseId: "response_closing",
      callId: "call_finish",
      itemId: "item_finish",
    });
  });

  it.each([
    [{ response_id: "response_closing" }, ["callId"]],
    [{ call_id: "call_finish" }, ["responseId"]],
    [{ response_id: "response_closing", call_id: "   " }, ["callId"]],
    [{}, ["callId", "responseId"]],
  ])(
    "keeps a finish tool completion with missing identity diagnostic (%o)",
    (identity, missingIdentities) => {
      expect(
        normalizeProviderRuntimeObservation(
          JSON.stringify({
            event_id: "event_incomplete_finish",
            type: "response.function_call_arguments.done",
            item_id: "item_finish",
            name: "finish_interview",
            arguments: "{}",
            ...identity,
          }),
          7,
        ),
      ).toMatchObject({
        kind: "provider_finish_interview_rejected",
        missingIdentities,
        itemId: "item_finish",
      });
    },
  );

  it.each(["{malformed", { unexpected: true }, null, undefined])(
    "preserves Interview finish argument tolerance (%o)",
    (argumentsValue) => {
      expect(
        normalizeProviderRuntimeObservation(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            name: "finish_interview",
            response_id: "tolerant-response",
            call_id: "tolerant-call",
            arguments: argumentsValue,
          }),
          9,
        ),
      ).toMatchObject({
        kind: "provider_finish_interview_observed",
        responseId: "tolerant-response",
        callId: "tolerant-call",
      });
    },
  );

  it("retains response terminal evidence when response.done rejects an incomplete finish call", () => {
    expect(
      normalizeProviderRuntimeObservation(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "response_closing",
            status: "failed",
            usage: realtimeUsage(),
            output: [
              {
                id: "item_finish",
                type: "function_call",
                name: "finish_interview",
              },
            ],
          },
        }),
        8,
      ),
    ).toMatchObject({
      kind: "provider_finish_interview_rejected",
      responseId: "response_closing",
      responseStatus: "failed",
      missingIdentities: ["callId"],
      usage: [{ status: "satisfied", key: "speech_to_speech:response_closing" }],
    });
  });
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

// These cases exercise the owning Conversation control projection, after native decoding.
/** Decodes a provider event as a Realtime session with the kit's default models does. */
function normalizeProviderRuntimeObservation(
  data: Parameters<typeof normalizeNativeObservation>[0],
  sequence: number,
) {
  const observation = normalizeNativeObservation(
    data,
    sequence,
    false,
    undefined,
    selectInterviewModels(),
  );
  return observation === null
    ? null
    : interpretConversationTools(
        runtimeReport(observation),
        admitImplementation(interviewAgent),
        null,
      );
}
