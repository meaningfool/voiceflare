import { describe, expect, it } from "vitest";
import { decodeResponseStreamEvent, openAiResponsesRequestBody } from "./openaiResponses.ts";
import {
  cerebrasChatCompletionsRequestBody,
  decodeCerebrasErrorBody,
  decodeCerebrasStreamData,
} from "./cerebrasChatCompletions.ts";
import { decodeGradiumRecognitionMessage } from "./gradiumSpeechInput.ts";
import { decodeGradiumSynthesisMessage } from "./gradiumSpeechOutput.ts";
import { decodeSynthesisMessage } from "./sonioxSpeechOutput.ts";
import { decodeRecognitionMessage } from "./sonioxSpeechInput.ts";
import type { LanguageModelRequest } from "./adapters.ts";

/** The model the session's settings name, which every request body carries. */
const model = "gpt-settings-model";

const literal: LanguageModelRequest = {
  history: [],
  instructions: { kind: "literal", text: "Say Welcome." },
  operationalInstructions: "",
  tools: [
    {
      type: "function",
      name: "finish_interview",
      description: "Finish when done.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
  toolChoice: "auto",
  maxOutputTokens: "inf",
  reasoning: null,
};

describe("OpenAI Responses request", () => {
  it("references a provider prompt and carries its operational instructions and limits", () => {
    expect(
      openAiResponsesRequestBody(model, {
        ...literal,
        instructions: {
          kind: "provider_prompt",
          prompt: { id: "pmpt_1", version: "3", variables: { event: "Expo" } },
        },
        operationalInstructions: "Speak English.",
        toolChoice: { type: "function", name: "finish_interview" },
        maxOutputTokens: 400,
        reasoning: { effort: "low" },
      }),
    ).toEqual({
      model: "gpt-settings-model",
      stream: true,
      store: false,
      input: [],
      prompt: { id: "pmpt_1", version: "3", variables: { event: "Expo" } },
      instructions: "Speak English.",
      tools: [
        {
          type: "function",
          name: "finish_interview",
          description: "Finish when done.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: "finish_interview" },
      reasoning: { effort: "low" },
      max_output_tokens: 400,
    });
  });

  it("sends no tools and no tool choice for a request that offers neither", () => {
    expect(openAiResponsesRequestBody(model, { ...literal, tools: [], toolChoice: null })).toEqual({
      model: "gpt-settings-model",
      stream: true,
      store: false,
      input: [{ role: "developer", content: "Say Welcome." }],
      reasoning: { effort: "none" },
    });
  });

  it("follows the prompt with the conversation so far, in order and verbatim", () => {
    const history = [
      { role: "interviewer", text: "Welcome. What worked well?" },
      { role: "participant", text: "The talks were clear." },
      { role: "interviewer", text: "What could improve?" },
      { role: "participant", text: "The lunch queue." },
    ] as const;
    expect(openAiResponsesRequestBody(model, { ...literal, history }).input).toEqual([
      { role: "developer", content: "Say Welcome." },
      { role: "assistant", content: "Welcome. What worked well?" },
      { role: "user", content: "The talks were clear." },
      { role: "assistant", content: "What could improve?" },
      { role: "user", content: "The lunch queue." },
    ]);
    expect(
      openAiResponsesRequestBody(model, {
        ...literal,
        history: history.slice(0, 2),
        instructions: { kind: "provider_prompt", prompt: { id: "pmpt_1" } },
      }).input,
    ).toEqual([
      { role: "assistant", content: "Welcome. What worked well?" },
      { role: "user", content: "The talks were clear." },
    ]);
  });
});

describe("OpenAI Responses stream events", () => {
  it("reads text, completed function calls and terminal outcomes", () => {
    expect(
      decodeResponseStreamEvent(
        JSON.stringify({ type: "response.output_text.delta", delta: "Hi", item_id: "m" }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "text", text: "Hi" },
    });
    expect(
      decodeResponseStreamEvent(
        JSON.stringify({
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "finish_interview",
            arguments: "{}",
            status: "completed",
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "tool_call", callId: "call_1", name: "finish_interview", arguments: "{}" },
    });
    expect(
      decodeResponseStreamEvent(
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "r",
            model: "gpt-5.4-mini-2026-03-17",
            usage: { input_tokens: 120, output_tokens: 14, total_tokens: 134 },
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "completed",
        usage: { model: "gpt-5.4-mini-2026-03-17", inputTokens: 120, outputTokens: 14 },
      },
    });
    // A completion whose usage account is missing or unusable still completes the response.
    for (const response of [
      { id: "r" },
      { id: "r", model: "m", usage: { input_tokens: "120", output_tokens: 14 } },
      { id: "r", model: "", usage: { input_tokens: 1, output_tokens: 1 } },
      { id: "r", usage: { input_tokens: 1, output_tokens: -1 } },
    ])
      expect(
        decodeResponseStreamEvent(JSON.stringify({ type: "response.completed", response })),
      ).toEqual({ ok: true, value: { kind: "completed", usage: null } });
    expect(
      decodeResponseStreamEvent(
        JSON.stringify({ type: "response.failed", response: { error: { code: "server_error" } } }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "failed", code: "openai_response_failed:server_error" },
    });
    expect(
      decodeResponseStreamEvent(
        JSON.stringify({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "failed", code: "openai_response_incomplete:max_output_tokens" },
    });
    expect(
      decodeResponseStreamEvent(JSON.stringify({ type: "error", code: null, message: "x" })),
    ).toEqual({
      ok: true,
      value: { kind: "failed", code: "openai_stream_error:unknown" },
    });
    // The provider's own shape, as an exhausted credit balance sends it.
    expect(
      decodeResponseStreamEvent(
        JSON.stringify({
          type: "error",
          error: {
            type: "insufficient_quota",
            code: "credit_balance_exhausted",
            message: "x",
            param: null,
          },
          sequence_number: 2,
        }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "failed", code: "openai_stream_error:credit_balance_exhausted" },
    });
  });

  it("reads each other completed output item as evidence: its type and a message's text length", () => {
    expect(
      decodeResponseStreamEvent(
        JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "Welcome. What worked well?", annotations: [] },
              { type: "refusal", refusal: "No." },
              { type: "output_text", text: "Hi" },
            ],
          },
        }),
      ),
    ).toEqual({ ok: true, value: { kind: "output_item", itemType: "message", characters: 28 } });
    // An item whose content the adapter cannot measure still reports its type.
    for (const item of [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "message", content: "Welcome." },
      { type: "message", content: [{ type: "output_text", text: 5 }] },
    ])
      expect(
        decodeResponseStreamEvent(JSON.stringify({ type: "response.output_item.done", item })),
      ).toEqual({
        ok: true,
        value: { kind: "output_item", itemType: item.type, characters: null },
      });
  });

  it("ignores other events, including partial function-call arguments", () => {
    for (const ignored of [
      { type: "response.function_call_arguments.delta", delta: "{" },
      { type: "response.output_item.added", item: { type: "message", content: [] } },
      { type: "response.output_item.done", item: { type: "" } },
      { type: "response.created", response: {} },
    ])
      expect(decodeResponseStreamEvent(JSON.stringify(ignored))).toEqual({
        ok: true,
        value: { kind: "ignored" },
      });
  });

  it("rejects what the adapter reads when its shape is wrong, rather than ignoring it", () => {
    for (const invalid of [
      { type: "response.output_text.delta", delta: 42 },
      { type: "response.output_text.delta" },
      {
        type: "response.output_item.done",
        item: { type: "function_call", name: "x", arguments: "{}" },
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c", name: "x", arguments: {} },
      },
      { type: "response.failed", response: { error: { code: 5 } } },
      { type: "response.failed" },
      { type: "error", error: { code: 5 } },
      { type: "error", error: "credit_balance_exhausted" },
      { type: 7 },
      {},
    ])
      expect(decodeResponseStreamEvent(JSON.stringify(invalid))).toEqual({
        ok: false,
        error: { code: "openai_stream_event_undecodable" },
      });
    expect(decodeResponseStreamEvent("not json").ok).toBe(false);
    expect(decodeResponseStreamEvent({ type: "response.completed" }).ok).toBe(false);
  });
});

describe("Cerebras Chat Completions request", () => {
  it("sends the history without the opening's empty user message, a forced tool, the lower cap and effort none when none is requested", () => {
    const body = cerebrasChatCompletionsRequestBody("qwen-3.8-27b", "Say Welcome.", {
      ...literal,
      history: [
        { role: "interviewer", text: "Welcome. What worked well?" },
        { role: "participant", text: "The talks." },
        { role: "interviewer", text: "Anything else?" },
      ],
      toolChoice: { type: "function", name: "finish_interview" },
      maxOutputTokens: 200,
      reasoning: { effort: "medium" },
    });
    expect(body).toMatchObject({
      messages: [
        { role: "system", content: "Say Welcome." },
        { role: "assistant", content: "Welcome. What worked well?" },
        { role: "user", content: "The talks." },
        { role: "assistant", content: "Anything else?" },
      ],
      tool_choice: { type: "function", function: { name: "finish_interview" } },
      reasoning_effort: "medium",
      max_completion_tokens: 200,
    });
    // With no effort requested, `none` is sent: left out, qwen would reason. A cap above
    // Cerebras's own is lowered to it.
    expect(
      cerebrasChatCompletionsRequestBody("qwen-3.8-27b", "x", {
        ...literal,
        maxOutputTokens: 4096,
      }),
    ).toMatchObject({ reasoning_effort: "none", max_completion_tokens: 1024 });
  });

  it("sends no tools and no tool choice for a request that offers neither", () => {
    expect(
      cerebrasChatCompletionsRequestBody("qwen-3.8-27b", "Say Welcome.", {
        ...literal,
        tools: [],
        toolChoice: null,
      }),
    ).toEqual({
      model: "qwen-3.8-27b",
      stream: true,
      messages: [
        { role: "system", content: "Say Welcome." },
        { role: "user", content: "" },
      ],
      reasoning_effort: "none",
      max_completion_tokens: 1024,
    });
  });
});

describe("Cerebras Chat Completions stream data", () => {
  /** The fields every chunk carries beside its choices. */
  const chunk = { id: "c", object: "chat.completion.chunk", model: "qwen-3.8-27b" };
  const call = { name: "finish_interview", arguments: "{}" };

  it("reads text, reasoning, whole tool calls, the finish with its usage, and the end marker", () => {
    expect(
      decodeCerebrasStreamData(
        JSON.stringify({
          ...chunk,
          choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }],
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "chunk",
        model: "qwen-3.8-27b",
        content: "Hi",
        reasoning: false,
        toolCalls: [],
        finishReason: null,
        usage: null,
      },
    });
    expect(
      decodeCerebrasStreamData(
        JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { reasoning: "Think." } }] }),
      ),
    ).toMatchObject({ ok: true, value: { content: "", reasoning: true } });
    const toolCall = { index: 0, id: "call_1", type: "function", function: call };
    expect(
      decodeCerebrasStreamData(
        JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] }),
      ),
    ).toMatchObject({ ok: true, value: { toolCalls: [{ callId: "call_1", ...call }] } });
    expect(
      decodeCerebrasStreamData(
        JSON.stringify({
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: {
            prompt_tokens: 1277,
            completion_tokens: 34,
            completion_tokens_details: { reasoning_tokens: 0 },
          },
          time_info: { queue_time: 0.002 },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: { finishReason: "tool_calls", usage: { inputTokens: 1277, outputTokens: 34 } },
    });
    expect(decodeCerebrasStreamData("[DONE]")).toEqual({ ok: true, value: { kind: "done" } });
  });

  it("rejects data the adapter cannot use", () => {
    const empty = [{ index: 0, delta: {} }];
    for (const invalid of [
      { ...chunk, model: "", choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { content: "Hi" } }] },
      { ...chunk, choices: [{ delta: { content: 7 } }] },
      // A tool call's fragment, without its id or name, or with arguments that are not text.
      { ...chunk, choices: [{ delta: { tool_calls: [{ index: 0, function: call }] } }] },
      {
        ...chunk,
        choices: [{ delta: { tool_calls: [{ id: "call_1", function: { arguments: "{" } }] } }],
      },
      {
        ...chunk,
        choices: [
          { delta: { tool_calls: [{ id: "call_1", function: { name: "f", arguments: {} } }] } },
        ],
      },
      { ...chunk, choices: [{ delta: {}, finish_reason: 1 }] },
      { ...chunk, choices: empty, usage: { prompt_tokens: -1, completion_tokens: 3 } },
      { ...chunk, choices: empty, usage: { prompt_tokens: 1.5, completion_tokens: 3 } },
      { ...chunk, choices: empty, usage: { completion_tokens: 3 } },
    ])
      expect(decodeCerebrasStreamData(JSON.stringify(invalid))).toEqual({
        ok: false,
        error: { code: "cerebras_stream_event_undecodable" },
      });
    for (const invalid of ["[done]", "{"])
      expect(decodeCerebrasStreamData(invalid)).toEqual({
        ok: false,
        error: { code: "cerebras_stream_event_undecodable" },
      });
  });
});

describe("Cerebras error bodies", () => {
  it("reads the refusal's code", () => {
    for (const code of ["queue_exceeded", "token_quota_exceeded"])
      expect(
        decodeCerebrasErrorBody(
          JSON.stringify({ message: "m", type: "too_many_requests_error", param: "queue", code }),
        ),
      ).toEqual({ ok: true, value: { code } });
  });

  it("rejects a body without a code", () => {
    for (const invalid of [
      JSON.stringify({ message: "m" }),
      JSON.stringify({ code: 429 }),
      JSON.stringify({ code: "" }),
      JSON.stringify({ error: { code: "queue_exceeded" } }),
      "",
      "<html>",
    ])
      expect(decodeCerebrasErrorBody(invalid)).toEqual({
        ok: false,
        error: { code: "cerebras_error_undecodable" },
      });
  });
});

describe("Soniox TTS messages", () => {
  it("reads audio with its end, termination and errors", () => {
    expect(
      decodeSynthesisMessage(JSON.stringify({ stream_id: "s", audio: "AAEC", audio_end: true })),
    ).toEqual({
      ok: true,
      value: { kind: "audio", streamId: "s", audio: new Uint8Array([0, 1, 2]), end: true },
    });
    expect(decodeSynthesisMessage(JSON.stringify({ stream_id: "s", audio: "AAEC" }))).toMatchObject(
      {
        ok: true,
        value: { kind: "audio", end: false },
      },
    );
    expect(decodeSynthesisMessage(JSON.stringify({ stream_id: "s", terminated: true }))).toEqual({
      ok: true,
      value: { kind: "terminated", streamId: "s" },
    });
    expect(
      decodeSynthesisMessage(
        JSON.stringify({
          stream_id: "s",
          error_code: 402,
          error_type: "insufficient_balance",
          error_message: "x",
        }),
      ),
    ).toEqual({ ok: true, value: { kind: "error", streamId: "s", type: "insufficient_balance" } });
  });

  it("rejects messages the adapter cannot use", () => {
    for (const invalid of [
      { stream_id: "s", audio: "not base64!" },
      { stream_id: "s", audio: 12 },
      { audio: "AAEC" },
      { stream_id: "s", audio: "AAEC", audio_end: "yes" },
      { stream_id: "s", terminated: false },
      { stream_id: "s", error_type: "" },
      { stream_id: "s" },
    ])
      expect(decodeSynthesisMessage(JSON.stringify(invalid))).toEqual({
        ok: false,
        error: { code: "soniox_message_undecodable" },
      });
    expect(decodeSynthesisMessage("{").ok).toBe(false);
    expect(decodeSynthesisMessage(new ArrayBuffer(2)).ok).toBe(false);
  });
});

describe("Gradium TTS messages", () => {
  it("reads ready, audio, the stream's end and errors, and ignores other types", () => {
    expect(
      decodeGradiumSynthesisMessage(
        JSON.stringify({ type: "ready", request_id: "r", sample_rate: 24_000 }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "ready" },
    });
    expect(decodeGradiumSynthesisMessage(JSON.stringify({ type: "audio", audio: "AAEC" }))).toEqual(
      {
        ok: true,
        value: { kind: "audio", audio: new Uint8Array([0, 1, 2]) },
      },
    );
    expect(decodeGradiumSynthesisMessage(JSON.stringify({ type: "end_of_stream" }))).toEqual({
      ok: true,
      value: { kind: "end" },
    });
    expect(
      decodeGradiumSynthesisMessage(
        JSON.stringify({ type: "error", message: "Invalid or expired API key", code: 1008 }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "error", code: 1008 },
    });
    expect(decodeGradiumSynthesisMessage(JSON.stringify({ type: "error", message: "x" }))).toEqual({
      ok: true,
      value: { kind: "error", code: null },
    });
    expect(
      decodeGradiumSynthesisMessage(JSON.stringify({ type: "text", text: "Thanks", start_s: 0.1 })),
    ).toEqual({
      ok: true,
      value: { kind: "ignored" },
    });
  });

  it("rejects messages the adapter cannot use", () => {
    for (const invalid of [
      { type: "audio", audio: "not base64!" },
      { type: "audio", audio: 12 },
      { type: "audio" },
      { type: "error", code: "1008" },
      { type: "error", code: 10.5 },
      { type: 7 },
      { audio: "AAEC" },
    ])
      expect(decodeGradiumSynthesisMessage(JSON.stringify(invalid))).toEqual({
        ok: false,
        error: { code: "gradium_message_undecodable" },
      });
    expect(decodeGradiumSynthesisMessage("{").ok).toBe(false);
    expect(decodeGradiumSynthesisMessage(new ArrayBuffer(2)).ok).toBe(false);
  });
});

describe("Gradium STT messages", () => {
  const vad = [
    { horizon_s: 0.5, inactivity_prob: 0.9 },
    { horizon_s: 2, inactivity_prob: 0.25 },
  ];

  it("reads ready, text, each step's inactivity, flushed, the stream's end and errors, and ignores other types", () => {
    expect(
      decodeGradiumRecognitionMessage(
        JSON.stringify({ type: "ready", sample_rate: 24_000, delay_in_frames: 10 }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "ready" },
    });
    expect(
      decodeGradiumRecognitionMessage(
        JSON.stringify({ type: "text", text: "The talks", start_s: 0.32 }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "text", text: "The talks" },
    });
    const inactivity = [
      { horizonS: 0.5, probability: 0.9 },
      { horizonS: 2, probability: 0.25 },
    ];
    // Older servers send `vad` where newer ones send `step`.
    for (const type of ["step", "vad"])
      expect(
        decodeGradiumRecognitionMessage(
          JSON.stringify({ type, vad, step_idx: 3, total_duration_s: 0.24 }),
        ),
      ).toEqual({
        ok: true,
        value: { kind: "step", inactivity },
      });
    expect(
      decodeGradiumRecognitionMessage(
        JSON.stringify({ type: "flushed", flush_id: 2, client_req_id: null }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "flushed", flushId: 2 },
    });
    expect(decodeGradiumRecognitionMessage(JSON.stringify({ type: "end_of_stream" }))).toEqual({
      ok: true,
      value: { kind: "end" },
    });
    expect(
      decodeGradiumRecognitionMessage(
        JSON.stringify({ type: "error", message: "Invalid or expired API key", code: 1008 }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "error", code: 1008 },
    });
    expect(
      decodeGradiumRecognitionMessage(JSON.stringify({ type: "error", message: "x" })),
    ).toEqual({
      ok: true,
      value: { kind: "error", code: null },
    });
    expect(
      decodeGradiumRecognitionMessage(JSON.stringify({ type: "end_text", stop_s: 1.2 })),
    ).toEqual({
      ok: true,
      value: { kind: "ignored" },
    });
  });

  it("rejects messages the adapter cannot use", () => {
    for (const invalid of [
      { type: "text" },
      { type: "text", text: 7 },
      { type: "step" },
      { type: "step", vad: [{ horizon_s: 2 }] },
      { type: "step", vad: [{ horizon_s: "2", inactivity_prob: 0.5 }] },
      { type: "vad", vad: [{ horizon_s: 2, inactivity_prob: 1.5 }] },
      { type: "flushed" },
      { type: "flushed", flush_id: "1" },
      { type: "flushed", flush_id: 1.5 },
      { type: "error", code: "1008" },
      { type: 7 },
      { text: "The talks" },
    ])
      expect(decodeGradiumRecognitionMessage(JSON.stringify(invalid))).toEqual({
        ok: false,
        error: { code: "gradium_message_undecodable" },
      });
    expect(decodeGradiumRecognitionMessage("{").ok).toBe(false);
    expect(decodeGradiumRecognitionMessage(new ArrayBuffer(2)).ok).toBe(false);
  });
});

describe("Soniox STT messages", () => {
  it("reads final tokens in order, ignoring provisional ones, and the stream's end", () => {
    expect(
      decodeRecognitionMessage(
        JSON.stringify({
          tokens: [
            { text: "The", start_ms: 0, end_ms: 100, confidence: 0.9, is_final: true },
            { text: " talks", is_final: true },
            { text: " were", is_final: false },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 760,
          total_audio_proc_ms: 880,
        }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: "tokens", final: ["The", " talks", "<end>"], finished: false },
    });
    expect(decodeRecognitionMessage(JSON.stringify({ tokens: [], finished: true }))).toEqual({
      ok: true,
      value: { kind: "tokens", final: [], finished: true },
    });
    expect(
      decodeRecognitionMessage(
        JSON.stringify({
          tokens: [],
          error_code: 401,
          error_type: "unauthenticated",
          error_message: "x",
        }),
      ),
    ).toEqual({ ok: true, value: { kind: "error", type: "unauthenticated" } });
  });

  it("rejects messages the adapter cannot use", () => {
    for (const invalid of [
      { tokens: [{ text: 1, is_final: true }] },
      { tokens: [{ text: "The" }] },
      { tokens: [{ text: "The", is_final: "true" }] },
      { tokens: "The" },
      { tokens: [], finished: "yes" },
      { error_type: "" },
      {},
    ])
      expect(decodeRecognitionMessage(JSON.stringify(invalid))).toEqual({
        ok: false,
        error: { code: "soniox_message_undecodable" },
      });
    expect(decodeRecognitionMessage("{").ok).toBe(false);
    expect(decodeRecognitionMessage(new ArrayBuffer(2)).ok).toBe(false);
  });
});
