import { describe, expect, it } from "vitest";
import type { LabCascadeProviderOptions } from "../data/cascadeProviderOptions";
import {
  applyLabCascadeChange,
  createLabCascadeChoices,
  labCascadeExecutionSettings,
  type LabCascadeChange,
} from "./labCascadeSettings";

// Today's speech input declares Gradium's turn rule, so a Start on today's provider can differ
// from today's settings by a turn value alone.
const options: LabCascadeProviderOptions = {
  speechInput: [
    {
      provider: "gradium",
      lists: { model: { values: ["default"], default: "default" } },
      numbers: {
        turnHorizon: { values: [0.5, 1, 2, 3], default: 2 },
        turnThreshold: { minimum: 0, maximum: 1, integer: false, default: 0.5 },
        turnSteps: { minimum: 1, maximum: 10, integer: true, default: 3 },
      },
    },
  ],
  languageModel: [{ provider: "openai", lists: {}, numbers: {} }],
  speechOutput: [{ provider: "soniox", lists: {}, numbers: {} }],
};

const turn = (setting: LabCascadeChange["setting"], value: string): LabCascadeChange => ({
  component: "speechInput",
  setting,
  value,
});

describe("Lab's Cascade turn settings", () => {
  it("sends no settings while every turn value is today's default", () => {
    const today = createLabCascadeChoices(options);
    const unchanged = applyLabCascadeChange(options, today, turn("turnSteps", "3"));
    expect(labCascadeExecutionSettings(options, unchanged)).toBeUndefined();
  });

  it("sends today's provider with its settings once one turn value differs", () => {
    const today = createLabCascadeChoices(options);
    const choices = applyLabCascadeChange(options, today, turn("turnThreshold", "0.8"));
    expect(labCascadeExecutionSettings(options, choices)).toEqual({
      speechInput: {
        provider: "gradium",
        model: "default",
        turnHorizon: 2,
        turnThreshold: 0.8,
        turnSteps: 3,
      },
    });
  });

  it.each([
    ["a horizon outside its values", turn("turnHorizon", "1.5")],
    ["a threshold above its maximum", turn("turnThreshold", "1.01")],
    ["a threshold below its minimum", turn("turnThreshold", "-0.1")],
    ["steps above the maximum", turn("turnSteps", "11")],
    ["steps below the minimum", turn("turnSteps", "0")],
    ["a fractional step count", turn("turnSteps", "2.5")],
    ["an empty value", turn("turnThreshold", "")],
    ["a value that is not a number", turn("turnThreshold", "high")],
    [
      "a turn setting the provider does not declare",
      { ...turn("turnSteps", "4"), component: "languageModel" as const },
    ],
  ])("changes nothing for %s", (_, change) => {
    const today = createLabCascadeChoices(options);
    expect(applyLabCascadeChange(options, today, change)).toBe(today);
  });
});
