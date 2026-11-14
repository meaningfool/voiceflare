import { describe, expect, it } from "vitest";
import { openAiDriverOver } from "./testing/testDriver.ts";
import {
  normalizeRealtimeUsage,
  normalizeTranscriptionUsage,
  realtimeUsageDeclarations,
} from "./usage.ts";

const models = {
  speechToSpeech: "gpt-realtime-2",
  speechToText: "gpt-4o-mini-transcribe",
} as const;

/** The usage entries a Realtime event reports, as the kit's driver hands the event to Runtime. */
function reportedUsage(eventJson: string, usageModels: typeof models | undefined = models) {
  const observation = openAiDriverOver().normalizeRuntimeObservation(eventJson, {
    sequence: 1,
    observedAt: 1,
    observeAllProviderEvents: false,
    usageModels,
  });
  return observation !== null && "usage" in observation ? observation.usage : undefined;
}

/** The entries of the reported usage that Realtime does not declare. */
function undeclared(usage: ReturnType<typeof reportedUsage>) {
  return (usage ?? [])
    .flatMap((item) => (item.status === "satisfied" ? item.measurements : []))
    .filter(
      (entry) =>
        !realtimeUsageDeclarations.some(
          (declared) =>
            declared.componentRole === entry.componentRole &&
            declared.provider === entry.provider &&
            declared.measure === entry.measure &&
            declared.unit === entry.unit,
        ),
    );
}

/** The Realtime kit turns OpenAI's usage into usage entries; Runtime only accounts them. */
describe("Realtime usage entries", () => {
  it("expects a response's usage when it starts and settles it with its entries when done", () => {
    expect(
      reportedUsage(JSON.stringify({ type: "response.created", response: { id: "response_1" } })),
    ).toEqual([
      { status: "expected", componentRole: "speech_to_speech", key: "speech_to_speech:response_1" },
    ]);
    const done = reportedUsage(
      JSON.stringify({
        type: "response.done",
        response: { id: "response_1", status: "completed", output: [], usage: realtimeUsage() },
      }),
    );
    expect(done).toEqual([
      {
        status: "satisfied",
        componentRole: "speech_to_speech",
        key: "speech_to_speech:response_1",
        measurements: [
          speech("uncached_input_text", 7),
          speech("cached_input_text", 3),
          speech("uncached_input_audio", 6),
          speech("cached_input_audio", 4),
          speech("output_text", 2),
          speech("output_audio", 3),
        ],
      },
    ]);
    // Every entry Realtime reports is one it declares.
    expect(undeclared(done)).toEqual([]);
  });

  it("expects a committed item's transcription and settles it per content part", () => {
    expect(
      reportedUsage(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "input_1" })),
    ).toEqual([
      { status: "expected", componentRole: "speech_to_text", key: "speech_to_text:input_1" },
    ]);
    const completed = reportedUsage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "input_1",
        content_index: 0,
        transcript: "Synthetic diagnostic sentence",
        usage: {
          type: "tokens",
          total_tokens: 55,
          input_tokens: 39,
          input_token_details: { text_tokens: 1, audio_tokens: 38 },
          output_tokens: 16,
        },
      }),
    );
    expect(completed).toEqual([
      {
        status: "satisfied",
        componentRole: "speech_to_text",
        key: "speech_to_text:input_1:0",
        pendingKey: "speech_to_text:input_1",
        measurements: [
          transcription("input_audio", 38),
          transcription("input_text", 1),
          transcription("output_text", 16),
        ],
      },
    ]);
    expect(undeclared(completed)).toEqual([]);
    expect(
      reportedUsage(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.failed",
          item_id: "input_1",
          error: { code: "transcription_failed" },
        }),
      ),
    ).toEqual([
      {
        status: "unavailable",
        componentRole: "speech_to_text",
        key: "speech_to_text:input_1:failed",
        pendingKey: "speech_to_text:input_1",
      },
    ]);
  });

  it("reports usage as invalid when the session's settings name no models", () => {
    const response = {
      type: "response.done",
      response: { id: "response_1", status: "completed", output: [], usage: realtimeUsage() },
    };
    expect(
      openAiDriverOver().normalizeRuntimeObservation(JSON.stringify(response), {
        sequence: 1,
        observedAt: 1,
        observeAllProviderEvents: false,
      }),
    ).toMatchObject({ usage: [{ status: "unavailable", key: "speech_to_speech:response_1" }] });
  });

  it("normalizes cached Realtime input into non-overlapping exact measures", () => {
    expect(
      normalizeRealtimeUsage(
        {
          ...realtimeUsage(),
          future_provider_field: true,
          input_token_details: {
            ...realtimeUsage().input_token_details,
            future_nested_field: "ignored",
          },
        },
        models,
      ),
    ).toEqual({
      status: "valid",
      observations: [
        speech("uncached_input_text", 7),
        speech("cached_input_text", 3),
        speech("uncached_input_audio", 6),
        speech("cached_input_audio", 4),
        speech("output_text", 2),
        speech("output_audio", 3),
      ],
    });
  });

  it.each([
    undefined,
    { ...realtimeUsage(), input_tokens: -1 },
    { ...realtimeUsage(), total_tokens: 26 },
    {
      ...realtimeUsage(),
      input_token_details: { ...realtimeUsage().input_token_details, image_tokens: 1 },
    },
    {
      ...realtimeUsage(),
      input_token_details: {
        ...realtimeUsage().input_token_details,
        cached_tokens_details: { text_tokens: 11, audio_tokens: 0, image_tokens: 0 },
      },
    },
  ])("rejects an entire invalid Realtime operation %#", (usage) => {
    expect(normalizeRealtimeUsage(usage, models)).toEqual({ status: "invalid" });
  });

  it.each([
    {},
    { ...realtimeUsage(), output_tokens: "5" },
    { ...realtimeUsage(), input_token_details: { cached_tokens: 0 } },
    { ...realtimeUsage(), output_token_details: { text_tokens: 2, audio_tokens: 3.5 } },
  ])("rejects malformed Realtime consumer contracts %#", (usage) => {
    expect(normalizeRealtimeUsage(usage, models)).toEqual({ status: "invalid" });
  });

  it.each([
    {},
    { ...transcriptionUsage(), output_tokens: "2" },
    { ...transcriptionUsage(), input_token_details: { audio_tokens: 5 } },
    { ...transcriptionUsage(), input_token_details: { audio_tokens: -1, text_tokens: 0 } },
    { ...transcriptionUsage(), input_token_details: { audio_tokens: 5, text_tokens: -1 } },
    { ...transcriptionUsage(), input_token_details: { audio_tokens: 5, text_tokens: "0" } },
    { ...transcriptionUsage(), input_token_details: { audio_tokens: 4.5, text_tokens: 0.5 } },
    { ...transcriptionUsage(), input_token_details: { audio_tokens: 5, text_tokens: 1 } },
    { ...transcriptionUsage(), total_tokens: 8 },
  ])("rejects malformed transcription consumer contracts %#", (usage) => {
    expect(normalizeTranscriptionUsage(usage, models)).toEqual({ status: "invalid" });
  });

  it("does not accept inherited provider counts as an operation payload", () => {
    expect(normalizeRealtimeUsage(Object.create(realtimeUsage()), models)).toEqual({
      status: "invalid",
    });
    const inheritedDetails = { ...realtimeUsage(), input_token_details: {} };
    Object.setPrototypeOf(
      inheritedDetails.input_token_details,
      realtimeUsage().input_token_details,
    );
    expect(normalizeRealtimeUsage(inheritedDetails, models)).toEqual({ status: "invalid" });
    expect(normalizeTranscriptionUsage(Object.create(transcriptionUsage()), models)).toEqual({
      status: "invalid",
    });
  });

  it("normalizes transcription usage while omitting zero input text", () => {
    expect(
      normalizeTranscriptionUsage({ ...transcriptionUsage(), future_field: true }, models),
    ).toEqual({
      status: "valid",
      observations: [transcription("input_audio", 5), transcription("output_text", 2)],
    });
    expect(
      normalizeTranscriptionUsage(
        { ...transcriptionUsage(), input_token_details: { audio_tokens: 4, text_tokens: 1 } },
        models,
      ),
    ).toEqual({
      status: "valid",
      observations: [
        transcription("input_audio", 4),
        transcription("input_text", 1),
        transcription("output_text", 2),
      ],
    });
  });

  it("reports valid all-zero operations as valid with no entries", () => {
    expect(
      normalizeRealtimeUsage(
        {
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          input_token_details: {
            text_tokens: 0,
            audio_tokens: 0,
            image_tokens: 0,
            cached_tokens: 0,
            cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
          },
          output_token_details: { text_tokens: 0, audio_tokens: 0 },
        },
        models,
      ),
    ).toEqual({ status: "valid", observations: [] });
    expect(
      normalizeTranscriptionUsage(
        {
          type: "tokens",
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          input_token_details: { audio_tokens: 0, text_tokens: 0 },
        },
        models,
      ),
    ).toEqual({ status: "valid", observations: [] });
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

function transcriptionUsage() {
  return {
    type: "tokens",
    total_tokens: 7,
    input_tokens: 5,
    output_tokens: 2,
    input_token_details: { audio_tokens: 5, text_tokens: 0 },
  };
}

function speech(measure: string, quantity: number) {
  return {
    componentRole: "speech_to_speech",
    provider: "openai",
    model: models.speechToSpeech,
    measure,
    unit: "token",
    quantity,
  };
}

function transcription(measure: string, quantity: number) {
  return {
    componentRole: "speech_to_text",
    provider: "openai",
    model: models.speechToText,
    measure,
    unit: "token",
    quantity,
  };
}
