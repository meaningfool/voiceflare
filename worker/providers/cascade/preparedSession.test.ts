import { describe, expect, it } from "vitest";
import type { ConversationCallbackJson } from "../../runtime/conversationContracts.ts";
import {
  decodeCascadeSessionSettings,
  prepareCascadeSettings,
  summarizeCascadeSettings,
} from "./preparedSession.ts";

/** Today's providers and their values, which a start without Cascade settings uses. */
const todays = {
  languageModel: { provider: "cerebras", model: "qwen-3.8-27b" },
  speechInput: {
    provider: "soniox",
    model: "stt-rt-v5",
    endpointSensitivity: -0.3,
    maxEndpointDelayMs: null,
    endpointLatencyAdjustmentLevel: null,
  },
  speechOutput: { provider: "soniox", model: "tts-rt-v2", voice: "Adrian" },
};

/**
 * Every Cascade setting given, each away from its default where its list allows another, in
 * groups that name no provider.
 */
const everySetting = {
  languageModel: { model: "qwen-3.8-27b" },
  speechInput: {
    model: "stt-rt-v6",
    endpointSensitivity: 0.5,
    maxEndpointDelayMs: 2_500,
    endpointLatencyAdjustmentLevel: 2,
  },
  speechOutput: { model: "tts-rt-v2", voice: "Nina" },
} as const;

/** The same settings, each group naming today's provider explicitly. */
const everySettingNamed = {
  languageModel: { provider: "cerebras", ...everySetting.languageModel },
  speechInput: { provider: "soniox", ...everySetting.speechInput },
  speechOutput: { provider: "soniox", ...everySetting.speechOutput },
} as const;

/** The Cascade kit's settings preparation, which the registry gives every Cascade pair. */
describe("Cascade settings preparation", () => {
  const prepare = (
    reasoningEffort: Parameters<typeof prepareCascadeSettings>[1]["reasoningEffort"],
    requested?: ConversationCallbackJson,
  ) =>
    prepareCascadeSettings(
      "cascade-v1/test",
      requested === undefined ? { reasoningEffort } : { reasoningEffort, requested },
    );

  it("uses today's provider values when the start gives no Cascade settings", () => {
    expect(prepare("low")).toEqual({
      combination: "cascade-v1/test",
      reasoning: { effort: "low" },
      toolChoice: "auto",
      maxOutputTokens: "inf",
      providers: todays,
    });
    expect(prepare(null, {}).providers).toEqual(todays);
  });

  it("sends a requested reasoning effort, and none for `none` or no request", () => {
    expect(prepare("none").reasoning).toBeNull();
    expect(prepare(null).reasoning).toBeNull();
  });

  it("uses each setting the start gives, and today's value for each one left out", () => {
    expect(prepare(null, everySetting).providers).toEqual(everySettingNamed);
    expect(prepare(null, { speechInput: { maxEndpointDelayMs: 500 } }).providers).toEqual({
      ...todays,
      speechInput: { ...todays.speechInput, maxEndpointDelayMs: 500 },
    });
    expect(
      prepare(null, {
        speechInput: { endpointSensitivity: -1, endpointLatencyAdjustmentLevel: 3 },
        speechOutput: { voice: "Daniel" },
      }).providers,
    ).toEqual({
      ...todays,
      speechInput: {
        ...todays.speechInput,
        endpointSensitivity: -1,
        endpointLatencyAdjustmentLevel: 3,
      },
      speechOutput: { provider: "soniox", model: "tts-rt-v2", voice: "Daniel" },
    });
  });

  it("uses the provider each group names, and today's provider for a group that names none", () => {
    expect(prepare(null, everySettingNamed).providers).toEqual(everySettingNamed);
    expect(
      prepare(null, {
        languageModel: { provider: "cerebras" },
        speechInput: { provider: "soniox" },
        speechOutput: { provider: "soniox" },
      }).providers,
    ).toEqual(todays);
    // OpenAI Responses stays selectable, with its own default model.
    expect(prepare("low", { languageModel: { provider: "openai" } })).toMatchObject({
      reasoning: { effort: "low" },
      providers: {
        ...todays,
        languageModel: { provider: "openai", model: "gpt-5.4-mini-2026-03-17" },
      },
    });
    expect(
      prepare(null, { speechOutput: { provider: "soniox", voice: "Nina" } }).providers,
    ).toEqual({ ...todays, speechOutput: { ...todays.speechOutput, voice: "Nina" } });
  });

  it("decides Gradium speech input's turn rule from its defaults and the settings given", () => {
    const gradium = {
      provider: "gradium",
      model: "default",
      delayInFrames: 10,
      turnHorizon: 2,
      turnThreshold: 0.5,
      turnSteps: 3,
    };
    expect(prepare(null, { speechInput: { provider: "gradium" } }).providers).toEqual({
      ...todays,
      speechInput: gradium,
    });
    const given = { delayInFrames: 48, turnHorizon: 0.5, turnThreshold: 0, turnSteps: 10 };
    expect(
      prepare(null, { speechInput: { provider: "gradium", ...given } }).providers.speechInput,
    ).toEqual({ ...gradium, ...given });
    for (const speechInput of [
      { delayInFrames: 9 },
      { delayInFrames: "10" },
      { turnHorizon: 1.5 },
      { turnThreshold: -0.1 },
      { turnThreshold: 1.1 },
      { turnSteps: 0 },
      { turnSteps: 11 },
      { turnSteps: 2.5 },
      { model: "stt-rt-v5" },
      { endpointSensitivity: 0 },
    ])
      expect(() => prepare(null, { speechInput: { provider: "gradium", ...speechInput } })).toThrow(
        "invalid_execution_settings",
      );
  });

  it("refuses an unknown setting and every value outside its list or range", () => {
    const refused = (requested: ConversationCallbackJson) => () => prepare(null, requested);
    const input = everySetting.speechInput;
    for (const requested of [
      { ...everySetting, reasoning: "low" },
      { ...everySetting, languageModel: { model: "gpt-5.5" } },
      { ...everySetting, languageModel: { model: "gpt-5.4-mini-2026-03-17", temperature: 1 } },
      { ...everySetting, speechInput: { ...input, model: "stt-async-v6" } },
      { ...everySetting, speechInput: { ...input, endpointSensitivity: -1.1 } },
      { ...everySetting, speechInput: { ...input, endpointSensitivity: 1.1 } },
      { ...everySetting, speechInput: { ...input, endpointSensitivity: "-0.3" } },
      { ...everySetting, speechInput: { ...input, maxEndpointDelayMs: 499 } },
      { ...everySetting, speechInput: { ...input, maxEndpointDelayMs: 3_001 } },
      { ...everySetting, speechInput: { ...input, maxEndpointDelayMs: 1_000.5 } },
      { ...everySetting, speechInput: { ...input, maxEndpointDelayMs: null } },
      { ...everySetting, speechInput: { ...input, endpointLatencyAdjustmentLevel: -1 } },
      { ...everySetting, speechInput: { ...input, endpointLatencyAdjustmentLevel: 4 } },
      { ...everySetting, speechInput: { ...input, endpointLatencyAdjustmentLevel: 1.5 } },
      { ...everySetting, speechInput: { ...input, languageHints: ["fr"] } },
      { ...everySetting, speechOutput: { model: "tts-rt-v1", voice: "Nina" } },
      { ...everySetting, speechOutput: { model: "tts-rt-v2", voice: "nina" } },
      { ...everySetting, speechOutput: { model: "tts-rt-v2", voice: "Nina", language: "fr" } },
      { ...everySetting, speechOutput: null },
      // A provider that is not registered for its component, or not named exactly.
      { ...everySetting, speechInput: { provider: "cerebras" } },
      { ...everySetting, languageModel: { provider: "anthropic" } },
      { ...everySetting, speechOutput: { provider: "openai" } },
      { ...everySetting, speechInput: { ...input, provider: "Soniox" } },
      { ...everySetting, speechInput: { ...input, provider: null } },
      // A field that is not the chosen provider's.
      { ...everySetting, speechInput: { provider: "soniox", voice: "Nina" } },
      { ...everySetting, languageModel: { provider: "openai", voice: "Adrian" } },
      { ...everySetting, speechOutput: { provider: "soniox", endpointSensitivity: 0 } },
      { model: "gpt-realtime-2.1", voice: "marin" },
      [],
      "cascade",
      null,
    ])
      expect(refused(requested)).toThrow("invalid_execution_settings");
  });

  it("reads a start's settings as JSON: an inherited field is not a setting", () => {
    const inherited = {};
    Object.setPrototypeOf(inherited, { speechOutput: { voice: "Nina" } });
    expect(prepare(null, inherited).providers).toEqual(todays);
    const nested = { speechOutput: { model: "tts-rt-v2" } };
    Object.setPrototypeOf(nested.speechOutput, { voice: "Nina", extra: true });
    expect(prepare(null, nested).providers).toEqual(todays);
  });

  it("reads back only the settings it prepared, as Runtime stored them", () => {
    const prepared = prepare("low", everySetting);
    expect(decodeCascadeSessionSettings(JSON.parse(JSON.stringify(prepared)))).toEqual(prepared);
    const { providers } = prepared;
    for (const invalid of [
      {
        ...prepared,
        providers: {
          ...providers,
          speechInput: { ...providers.speechInput, provider: "cerebras" },
        },
      },
      { ...prepared, providers: { ...providers, languageModel: { provider: "openai" } } },
      { ...prepared, model: "cascade-v1/test" },
      { ...prepared, providers: undefined },
      { ...prepared, providers: { ...providers, extra: true } },
      { ...prepared, providers: { ...providers, languageModel: { model: 5 } } },
      {
        ...prepared,
        providers: {
          ...providers,
          speechInput: { ...providers.speechInput, endpointSensitivity: "-0.3" },
        },
      },
      {
        ...prepared,
        providers: { ...providers, speechInput: { model: providers.speechInput.model } },
      },
      { ...prepared, providers: { ...providers, speechOutput: { model: "tts-rt-v2" } } },
      null,
    ])
      expect(() => decodeCascadeSessionSettings(invalid)).toThrow();
  });

  it("reads settings stored before groups named their provider as the providers #1020 used", () => {
    // A Run's prepared settings as #1020 stored them: no group names its provider, and the
    // language model was OpenAI Responses, whatever today's provider is.
    const providers = {
      languageModel: { model: "gpt-5.4-mini-2026-03-17" },
      speechInput: everySetting.speechInput,
      speechOutput: everySetting.speechOutput,
    };
    const stored = {
      combination: "cascade-v1/test",
      reasoning: null,
      toolChoice: "auto",
      maxOutputTokens: "inf",
      providers,
    };
    expect(decodeCascadeSessionSettings(stored)).toEqual({
      ...stored,
      providers: {
        languageModel: { provider: "openai", ...providers.languageModel },
        speechInput: everySettingNamed.speechInput,
        speechOutput: everySettingNamed.speechOutput,
      },
    });
  });

  it("summarizes the settings for the Run's diagnostics, with each provider and what it used", () => {
    expect(summarizeCascadeSettings(prepare("low"))).toEqual({
      model: "cascade-v1/test",
      maxOutputTokens: "inf",
      reasoningEffort: "low",
      ...todays,
    });
    expect(summarizeCascadeSettings(prepare(null, everySetting))).toEqual({
      model: "cascade-v1/test",
      maxOutputTokens: "inf",
      ...everySettingNamed,
    });
  });
});
