import { describe, expect, it } from "vitest";
import {
  parseFailedToStartResult,
  parseRuntimeStartFailure,
  parseRuntimeTerminalResult,
} from "./runtimeTerminalResult.ts";

describe("terminal result and acceptance ingress", () => {
  const result = {
    runId: "response_1",
    outcome: "failed_to_start",
    endedAt: 123,
    runtimeUsage: { completeness: "complete", observations: [] },
  };
  it("returns the owned failed-start value, without sharing the raw object", () => {
    expect(parseFailedToStartResult(result)).toEqual(result);
    expect(parseFailedToStartResult(result)).not.toBe(result);
  });
  it.each([
    {},
    { runId: "response_1", outcome: "failed_to_start", endedAt: 123 },
    { ...result, runtimeUsage: {} },
    { ...result, runtimeUsage: { completeness: "complete", observations: [{}] } },
    { ...result, runtimeUsage: { completeness: 42, observations: [] } },
    { ...result, runtimeUsage: { completeness: "complete", observations: "none" } },
    { ...result, runId: 3 },
    { ...result, runId: " " },
    { ...result, endedAt: -1 },
    { ...result, endedAt: "123" },
    { ...result, endedAt: { at: 123 } },
    { ...result, outcome: "ended" },
    { ...result, liveAt: 1 },
    { ...result, transcript: { turns: [] } },
    { ...result, endedAt: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed or expanded result %j", (value) => {
    expect(parseFailedToStartResult(value)).toBeNull();
  });
  it("cannot obtain required fields from the prototype", () => {
    expect(parseFailedToStartResult(Object.create(result))).toBeNull();
    const own: unknown = Object.assign(Object.create({ leaked: true }), result);
    expect(parseFailedToStartResult(own)).toEqual(result);
  });
  it.each(["accepted", "not_accepted"])("reads explicit %s acceptance", (acceptance) => {
    expect(parseRuntimeStartFailure({ error: "setup_failed", acceptance })).toEqual({
      error: "setup_failed",
      acceptance,
    });
  });
  it.each([
    {},
    { error: 42, acceptance: "accepted" },
    { error: "failure" },
    { error: "failure", acceptance: true },
    { error: "failure", acceptance: { state: "accepted" } },
    { error: "failure", acceptance: "unknown" },
    { error: "failure", acceptance: "accepted", extra: true },
  ])("rejects untrustworthy acceptance %j", (value) => {
    expect(parseRuntimeStartFailure(value)).toBeNull();
  });
  it("rejects inherited acceptance", () => {
    expect(
      parseRuntimeStartFailure(Object.create({ error: "failure", acceptance: "accepted" })),
    ).toBeNull();
  });
});

describe("Conversation evidence gap result ingress", () => {
  const result = {
    runId: "gap_run",
    outcome: "interrupted",
    liveAt: 100,
    endedAt: 200,
    transcriptSnapshot: { revision: 0, digest: `sha256:${"0".repeat(64)}`, turnCount: 0 },
    transcriptCompleteness: "incomplete",
    transcriptIncompleteReasons: [{ kind: "conversation_evidence_gap" }],
    runtimeUsage: { completeness: "complete", observations: [] },
  };
  it("owns the finite gap reason while retaining older complete results", () => {
    expect(parseRuntimeTerminalResult(result)).toEqual(result);
    expect(
      parseRuntimeTerminalResult({
        ...result,
        transcriptCompleteness: "complete",
        transcriptIncompleteReasons: [],
      }),
    ).not.toBeNull();
  });
  it.each([
    { kind: "conversation_evidence_gap", itemId: "unowned" },
    { kind: 42 },
    { kind: "unbounded_evidence_gap" },
    {},
  ])("rejects malformed gap reason %j", (reason) => {
    expect(
      parseRuntimeTerminalResult({ ...result, transcriptIncompleteReasons: [reason] }),
    ).toBeNull();
  });
  it("rejects a complete result carrying a gap and inherited reasons", () => {
    expect(
      parseRuntimeTerminalResult({ ...result, transcriptCompleteness: "complete" }),
    ).toBeNull();
    expect(
      parseRuntimeTerminalResult({
        ...result,
        transcriptIncompleteReasons: [Object.create({ kind: "conversation_evidence_gap" })],
      }),
    ).toBeNull();
  });
});

describe("published usage entries", () => {
  const result = {
    runId: "usage_run",
    outcome: "failed_to_start",
    endedAt: 123,
    runtimeUsage: { completeness: "complete", observations: [] },
  };
  const entry = {
    componentRole: "text_to_speech",
    provider: "soniox",
    model: "tts-rt-v2",
    measure: "input_text",
    unit: "character",
    quantity: 92,
  };
  const withEntries = (observations: readonly unknown[]) => ({
    ...result,
    runtimeUsage: { completeness: "complete", observations },
  });
  it("accepts any declared names in each unit of the closed list", () => {
    const observations = [
      { ...entry, componentRole: "language_model", provider: "openai", unit: "token" },
      {
        ...entry,
        componentRole: "speech_to_text",
        measure: "input_audio",
        unit: "audio_millisecond",
      },
      entry,
    ];
    expect(parseFailedToStartResult(withEntries(observations))).toEqual(withEntries(observations));
  });
  it.each([
    { ...entry, unit: "second" },
    { ...entry, componentRole: " " },
    { ...entry, provider: "" },
    { ...entry, model: 42 },
    { ...entry, measure: undefined },
    { ...entry, quantity: 0 },
    { ...entry, quantity: 1.5 },
    { ...entry, extra: true },
  ])("rejects an entry outside the fixed shape %j", (invalid) => {
    expect(parseFailedToStartResult(withEntries([invalid]))).toBeNull();
  });
  it("rejects repeated or unordered entries", () => {
    expect(parseFailedToStartResult(withEntries([entry, entry]))).toBeNull();
    expect(
      parseFailedToStartResult(withEntries([entry, { ...entry, componentRole: "language_model" }])),
    ).toBeNull();
  });
});
