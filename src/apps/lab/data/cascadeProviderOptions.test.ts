import { describe, expect, it } from "vitest";
import { decodeLabCascadeProviderOptions } from "./cascadeProviderOptions";

const soniox = {
  provider: "soniox",
  lists: {
    model: { values: ["tts-rt-v2"], default: "tts-rt-v2" },
    voice: { values: ["Adrian", "Nina"], default: "Adrian" },
  },
  numbers: {},
};
const turnRule = {
  turnHorizon: { values: [0.5, 1, 2, 3], default: 2 },
  turnThreshold: { minimum: 0, maximum: 1, integer: false, default: 0.5 },
  turnSteps: { minimum: 1, maximum: 10, integer: true, default: 3 },
};
const gradium = { provider: "gradium", lists: {}, numbers: turnRule };
const valid = {
  speechInput: [{ provider: "soniox", lists: {}, numbers: {} }, gradium],
  languageModel: [
    { provider: "openai", lists: { model: { values: ["m"], default: "m" } }, numbers: {} },
  ],
  speechOutput: [soniox],
};
const withTurn = (numbers: Partial<Record<keyof typeof turnRule | "delayInFrames", object>>) => ({
  ...valid,
  speechInput: [{ ...gradium, numbers: { ...turnRule, ...numbers } }],
});

describe("Lab Worker's Cascade providers, as the page reads them", () => {
  it("returns each component's providers, their listed settings and their numeric settings", () => {
    expect(decodeLabCascadeProviderOptions(valid)).toEqual(valid);
  });

  it.each([
    ["a missing component", { speechInput: valid.speechInput, languageModel: valid.languageModel }],
    ["a component with no provider", { ...valid, speechInput: [] }],
    ["a provider without a name", { ...valid, speechInput: [{ lists: {}, numbers: {} }] }],
    [
      "a provider named by a number",
      { ...valid, speechInput: [{ provider: 1, lists: {}, numbers: {} }] },
    ],
    ["a provider without lists", { ...valid, speechInput: [{ provider: "soniox", numbers: {} }] }],
    ["a provider without numbers", { ...valid, speechInput: [{ provider: "soniox", lists: {} }] }],
    [
      "a numeric default outside its values",
      withTurn({ turnHorizon: { values: [1, 2], default: 3 } }),
    ],
    ["an empty numeric list", withTurn({ turnHorizon: { values: [], default: 2 } })],
    ["a numeric list of text", withTurn({ turnHorizon: { values: ["2"], default: "2" } })],
    [
      "a default below the minimum",
      withTurn({ turnThreshold: { minimum: 0, maximum: 1, integer: false, default: -0.5 } }),
    ],
    [
      "a default above the maximum",
      withTurn({ turnSteps: { minimum: 1, maximum: 10, integer: true, default: 11 } }),
    ],
    [
      "a minimum that is not below the maximum",
      withTurn({ turnThreshold: { minimum: 1, maximum: 1, integer: false, default: 1 } }),
    ],
    [
      "a fractional default for a whole-number setting",
      withTurn({ turnSteps: { minimum: 1, maximum: 10, integer: true, default: 2.5 } }),
    ],
    [
      "a range without its integer flag",
      withTurn({ turnSteps: { minimum: 1, maximum: 10, default: 3 } }),
    ],
    [
      "a range with a limit given as text",
      withTurn({ turnSteps: { minimum: "1", maximum: 10, integer: true, default: 3 } }),
    ],
    [
      "a numeric setting with both values and limits",
      withTurn({
        turnHorizon: { values: [2], minimum: 0, maximum: 3, integer: false, default: 2 },
      }),
    ],
    [
      "a numeric setting the page does not offer",
      withTurn({ delayInFrames: { values: [10], default: 10 } }),
    ],
    ["a provider listed twice", { ...valid, speechOutput: [soniox, soniox] }],
    [
      "a default outside its values",
      {
        ...valid,
        speechOutput: [{ ...soniox, lists: { voice: { values: ["Nina"], default: "X" } } }],
      },
    ],
    [
      "an empty list",
      { ...valid, speechOutput: [{ ...soniox, lists: { voice: { values: [], default: "X" } } }] },
    ],
    [
      "a listed value that is not text",
      { ...valid, speechOutput: [{ ...soniox, lists: { voice: { values: [3], default: 3 } } }] },
    ],
    [
      "a setting the page does not offer",
      {
        ...valid,
        speechOutput: [{ ...soniox, lists: { speed: { values: ["1"], default: "1" } } }],
      },
    ],
    ["an unknown component", { ...valid, vision: [] }],
  ])("rejects %s", (_, value) => {
    expect(() => decodeLabCascadeProviderOptions(value)).toThrow();
  });

  it("does not accept an inherited required component", () => {
    const { speechOutput, ...own } = valid;
    expect(() =>
      decodeLabCascadeProviderOptions(Object.assign(Object.create({ speechOutput }), own)),
    ).toThrow();
  });
});
