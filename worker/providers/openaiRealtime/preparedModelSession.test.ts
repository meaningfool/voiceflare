import { describe, expect, it } from "vitest";
import type { PreparedConversationNode } from "../../runtime/nodeContentContracts.ts";
import type { ConversationCallbackJson } from "../../runtime/conversationContracts.ts";
import type { RealtimeExecutionSettings } from "./settings.ts";
import {
  composeRealtimeSession,
  decodeRealtimeSessionSettings,
  prepareRealtimeSettings,
  type ReasoningEffort,
  summarizePreparedModelSession,
  summarizeProviderRealtimeSessionEvent,
  summarizeRealtimeSessionConfig,
  toProviderRealtimeSession,
} from "./preparedModelSession.ts";

/** A Run's call session as Realtime's start composes it: the node's content under its settings. */
function prepareAgentModelSession(
  input: Readonly<{
    runId: string;
    reasoningEffort?: ReasoningEffort | null;
    labRealtimeSettings?: RealtimeExecutionSettings;
  }>,
  node: PreparedConversationNode,
) {
  return composeRealtimeSession(
    input.runId,
    node,
    prepareRealtimeSettings({
      reasoningEffort: input.reasoningEffort ?? null,
      requested: input.labRealtimeSettings,
    }),
  );
}

/** A Conversation node with one literal prompt and one tool, as an implementation prepares it. */
function literalNode(text: string): PreparedConversationNode {
  return {
    instructions: { kind: "literal", text },
    operationalInstructions: "",
    tools: [
      {
        type: "function",
        name: "finish_interview",
        description: "Sample finish description.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  };
}

describe("PreparedModelSession", () => {
  it("owns only supported diagnostic session fields", () => {
    const config = summarizeRealtimeSessionConfig;
    const event = summarizeProviderRealtimeSessionEvent;
    const raw = {
      model: "native-model",
      audio: {
        output: { voice: "native-voice" },
        input: {
          turn_detection: { type: "semantic_vad", create_response: true, ignored: "excluded" },
        },
      },
      ignored: "excluded",
    };
    const expected = {
      model: "native-model",
      voice: "native-voice",
      turnDetection: { type: "semantic_vad", createResponse: true },
    };
    expect(config(raw)).toEqual(expected);
    expect(config({ model: 42, voice: [], audio: { input: { turn_detection: 42 } } })).toEqual({});
    expect(config(null)).toEqual({});
    expect(event({ type: "session.updated", session: raw })).toEqual(expected);
    expect(event({ type: "session.created", session: raw })).toEqual(expected);
    expect(event({ type: "session.updated", session: null })).toBeNull();
    expect(event({ type: "unrecognized", session: raw })).toBeNull();
    expect(config({ model: "native-model", __proto__: { ignored: "excluded" } })).toEqual({
      model: "native-model",
    });
  });

  it("sends selected Lab settings through the existing provider payload", () => {
    const labRealtimeSettings = {
      model: "gpt-realtime-2.1",
      voice: "cedar",
      speed: 1.25,
      inputNoiseReduction: "off",
      semanticVadEagerness: "high",
      maxOutputTokens: "inf",
      truncation: "disabled",
    } as const;
    const session = prepareAgentModelSession(
      { runId: "lab_1", reasoningEffort: "none", labRealtimeSettings },
      literalNode("Ask why"),
    );
    const payload = toProviderRealtimeSession(session);
    expect(payload).toMatchObject({
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      max_output_tokens: "inf",
      truncation: "disabled",
      audio: {
        input: {
          noise_reduction: null,
          transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "high",
            create_response: true,
            interrupt_response: false,
          },
        },
        output: { voice: "cedar", speed: 1.25 },
      },
      tracing: null,
    });
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("include");
    expect(summarizePreparedModelSession(session)).toMatchObject({
      model: "gpt-realtime-2.1",
      maxOutputTokens: "inf",
    });
    expect(
      prepareAgentModelSession(
        { runId: "lab_2", reasoningEffort: "xhigh", labRealtimeSettings },
        literalNode("Ask why"),
      ).reasoning,
    ).toEqual({ effort: "xhigh" });
  });

  it("refuses execution settings that are not Realtime's, whole or inherited", () => {
    const settings = {
      model: "gpt-realtime-2.1",
      voice: "cedar",
      speed: 1.25,
      inputNoiseReduction: "off",
      semanticVadEagerness: "high",
      maxOutputTokens: "inf",
      truncation: "disabled",
    } as const;
    const prepare = (requested: ConversationCallbackJson) => () =>
      prepareRealtimeSettings({ reasoningEffort: null, requested });
    expect(prepare(settings)).not.toThrow();
    const { model, ...inherited } = settings;
    Object.setPrototypeOf(inherited, { model });
    expect(prepare(inherited)).toThrow("invalid_execution_settings");
    for (const change of [
      { speed: 0.2 },
      { speed: 1.6 },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 4097 },
      { model: "gpt-realtime-mini" },
      { voice: "custom" },
      { inputNoiseReduction: "noise" },
      { semanticVadEagerness: "highest" },
      { truncation: "manual" },
      { extra: true },
    ])
      expect(prepare({ ...settings, ...change })).toThrow("invalid_execution_settings");
  });

  it("reads back only the settings it prepared, as Runtime stored them", () => {
    const prepared = prepareRealtimeSettings({ reasoningEffort: "low" });
    expect(decodeRealtimeSessionSettings(JSON.parse(JSON.stringify(prepared)))).toEqual(prepared);
    for (const invalid of [
      { ...prepared, model: "" },
      { ...prepared, extra: true },
      {
        ...prepared,
        inputAudio: { ...prepared.inputAudio, turnDetection: { type: "server_vad" } },
      },
      null,
    ])
      expect(() => decodeRealtimeSessionSettings(invalid)).toThrow();
  });

  it("prepares the complete effective model session", () => {
    const session = prepareAgentModelSession(
      { runId: "run_123", reasoningEffort: "high" },
      literalNode("Distinctive Lab instructions"),
    );

    expect(session).toMatchObject({
      runId: "run_123",
      model: "gpt-realtime-2.1",
      instructions: {
        kind: "literal",
        text: "Distinctive Lab instructions",
      },
      reasoning: { effort: "high" },
      outputModalities: ["audio"],
      toolChoice: "auto",
      maxOutputTokens: 700,
      truncation: "auto",
      inputAudio: {
        noiseReduction: { type: "far_field" },
        transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
        turnDetection: {
          type: "semantic_vad",
          eagerness: "medium",
          createResponse: true,
          interruptResponse: false,
        },
      },
      outputAudio: { voice: "marin", speed: 1 },
      include: [],
      tracing: null,
    });
    expect(session.operationalInstructions).toBe("");
    expect(session.tools).toEqual(literalNode("").tools);
  });

  it("maps only prepared values into the provider session shape", () => {
    const session = prepareAgentModelSession({ runId: "run_123" }, literalNode("Raw instructions"));

    expect(toProviderRealtimeSession(session)).toEqual({
      type: "realtime",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      instructions: "Raw instructions",
      tools: [
        {
          type: "function",
          name: "finish_interview",
          description: session.tools[0]?.description,
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      tool_choice: "auto",
      audio: {
        input: {
          noise_reduction: { type: "far_field" },
          transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: false,
          },
        },
        output: { voice: "marin", speed: 1 },
      },
      tracing: null,
      truncation: "auto",
      max_output_tokens: 700,
    });
  });

  it("uses only supplied supplemental instructions alongside a provider prompt reference", () => {
    const session = prepareAgentModelSession(
      { runId: "run_123" },
      {
        ...literalNode(""),
        instructions: {
          kind: "provider_prompt",
          prompt: { id: "prompt_123", version: "2", variables: { locale: "en" } },
        },
      },
    );

    const providerSession = toProviderRealtimeSession(session);
    expect(providerSession).toMatchObject({
      prompt: {
        id: "prompt_123",
        version: "2",
        variables: { locale: "en" },
      },
    });
    expect(providerSession.instructions).toBe("");
  });

  it("keeps the existing secret-safe session summary shape", () => {
    const session = prepareAgentModelSession(
      { runId: "run_123", reasoningEffort: "low" },
      literalNode("Do not persist this prompt"),
    );

    expect(summarizePreparedModelSession(session)).toEqual({
      model: "gpt-realtime-2.1",
      voice: "marin",
      maxOutputTokens: 700,
      reasoningEffort: "low",
      inputNoiseReduction: { type: "far_field" },
      turnDetection: {
        type: "semantic_vad",
        eagerness: "medium",
        createResponse: true,
        interruptResponse: false,
      },
    });
  });
});
