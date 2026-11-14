import { describe, expect, it } from "vitest";
import type { LabRunDetail } from "../data/labRunStore";
import { formatOutputUsage, getMatchedAnswerUsage, getOutputUsageSummary } from "./outputUsage";

const baseRun: LabRunDetail = {
  runId: "run_1",
  startedAt: 1,
  transcriptTurnCount: 3,
  transcript: {
    turns: [
      { role: "conversationAgent", text: "First answer" },
      { role: "participant", text: "Question" },
      { role: "conversationAgent", text: "Second answer" },
    ],
  },
  maxOutputTokens: 100,
  responseUsage: [
    { responseId: "resp_1", outputTokens: 79, answerTurnNumber: 1 },
    { responseId: "resp_2", outputTokens: 80, answerTurnNumber: 3 },
    { responseId: "resp_3", outputTokens: 101 },
  ],
};

describe("Lab response output usage", () => {
  it("summarizes every reported response, including unmatched usage", () => {
    expect(getOutputUsageSummary(baseRun)).toEqual({
      peak: 101,
      nearLimitCount: 2,
      responseCount: 3,
    });
    expect(formatOutputUsage(80, 100)).toBe("80 / 100 output tokens (80%)");
  });

  it("keeps unmatched or invalid answer associations out of transcript turns", () => {
    const run: LabRunDetail = {
      ...baseRun,
      responseUsage: [
        ...(baseRun.responseUsage ?? []),
        { responseId: "resp_4", outputTokens: 5, answerTurnNumber: 2 },
        { responseId: "resp_5", outputTokens: 7, answerTurnNumber: 4 },
      ],
    };
    expect([...getMatchedAnswerUsage(run).entries()]).toEqual([
      [1, run.responseUsage?.[0]],
      [3, run.responseUsage?.[1]],
    ]);
  });

  it("does not assign ambiguous duplicate matches", () => {
    const run: LabRunDetail = {
      ...baseRun,
      responseUsage: [
        ...(baseRun.responseUsage ?? []),
        { responseId: "resp_4", outputTokens: 7, answerTurnNumber: 1 },
      ],
    };
    expect([...getMatchedAnswerUsage(run).keys()]).toEqual([3]);
  });

  it("shows unlimited counts without percentages", () => {
    const run = { ...baseRun, maxOutputTokens: "inf" as const };
    expect(getOutputUsageSummary(run)).toEqual({
      peak: 101,
      nearLimitCount: null,
      responseCount: 3,
    });
    expect(formatOutputUsage(101, "inf")).toBe("101 output tokens");
  });
});
