import { describe, expect, it } from "vitest";

import {
  runtimeUsageObservationSchema,
  type RuntimeUsageObservation,
  type UsageDeclaration,
} from "../shared/contracts/runtimeTerminalResult.ts";
import { admitDeclaredUsage, observeConversationUsage } from "./conversationUsage.ts";
import type {
  FinalizationObservation,
  InterviewFinalizationStage,
} from "./interviewFinalizationModel.ts";
import {
  admitRuntimeUsageOperation,
  applyRuntimeUsageEvidence,
  createRuntimeUsageAccounting,
  markRuntimeUsageIncomplete,
  parseRuntimeUsageAccountingState,
  sealRuntimeUsage,
  settleRuntimeUsageOperation,
  type ConversationUsageEvidence,
  type RuntimeUsageAccountingState,
} from "./runtimeUsage.ts";

function applyRuntimeUsageObservation(
  state: RuntimeUsageAccountingState,
  observation: FinalizationObservation,
  stage: InterviewFinalizationStage | "setup",
) {
  return applyRuntimeUsageEvidence(state, observeConversationUsage(observation, stage, state));
}

/** Runtime accounts the entries an execution reports; each names its own model. */
describe("Runtime usage accounting", () => {
  it("settles a valid operation with no entries as complete", () => {
    const expected = admitRuntimeUsageOperation(createRuntimeUsageAccounting(), {
      componentRole: "language_model",
      key: "zero",
    });
    const settled = settleRuntimeUsageOperation(expected, {
      componentRole: "language_model",
      key: "zero",
      usage: { status: "valid", observations: [] },
    });
    expect(sealRuntimeUsage(settled)).toEqual({ completeness: "complete", observations: [] });
    expect(settled.processedKeys).toEqual(["zero"]);
  });

  it("retains settled entries through recovery and replay", () => {
    const admission = {
      kind: "session_activity_observed" as const,
      at: 1,
      generation: 1,
      sequence: 1,
      usage: [expected("speech_to_text", "input_1")],
    };
    const terminal = {
      kind: "session_activity_observed" as const,
      at: 2,
      generation: 1,
      sequence: 2,
      usage: [
        satisfied("speech_to_text", "input_1:0", [entry("speech_to_text", "input_audio", 38)], {
          pendingKey: "speech_to_text:input_1",
        }),
      ],
    };
    let state = applyRuntimeUsageObservation(createRuntimeUsageAccounting(), admission, "live");
    state = applyRuntimeUsageObservation(state, terminal, "live");
    const restored = parseRuntimeUsageAccountingState(JSON.stringify(state));
    if (restored === null) throw new Error("Expected persisted usage");
    state = applyRuntimeUsageObservation(restored, admission, "live");
    state = applyRuntimeUsageObservation(state, terminal, "live");
    expect(sealRuntimeUsage(state)).toEqual({
      completeness: "complete",
      observations: [entry("speech_to_text", "input_audio", 38)],
    });
    expect(state.pending).toEqual([]);
  });

  it("persists pending identities, sums valid operations once, and preserves sums on failure", () => {
    const usage = [
      entry("language_model", "input_text", 7),
      entry("language_model", "output_text", 2),
    ];
    const state = applyRuntimeUsageEvidence(createRuntimeUsageAccounting(), [
      expected("language_model", "output_1"),
      satisfied("language_model", "output_1", usage),
      satisfied("language_model", "output_1", usage),
      { status: "unavailable", componentRole: "language_model", key: "language_model:output_2" },
    ]);
    expect(sealRuntimeUsage(state)).toEqual({ completeness: "incomplete", observations: usage });
  });

  it("keeps the model each entry names, summing only entries of the same model", () => {
    const named = (model: string, quantity: number): RuntimeUsageObservation => ({
      ...entry("speech_to_text", "input_audio", quantity),
      model,
    });
    const state = applyRuntimeUsageEvidence(createRuntimeUsageAccounting(), [
      satisfied("speech_to_text", "first", [named("first-model", 2), named("second-model", 3)]),
      satisfied("speech_to_text", "second", [named("first-model", 4)]),
    ]);
    expect(sealRuntimeUsage(state).observations).toEqual([
      named("first-model", 6),
      named("second-model", 3),
    ]);
  });

  it("distinguishes complete-empty, incomplete-empty, and unsettled-empty", () => {
    const empty = createRuntimeUsageAccounting();
    expect(sealRuntimeUsage(empty)).toEqual({ completeness: "complete", observations: [] });
    expect(sealRuntimeUsage(markRuntimeUsageIncomplete(empty))).toEqual({
      completeness: "incomplete",
      observations: [],
    });
    expect(
      sealRuntimeUsage(applyRuntimeUsageEvidence(empty, [expected("language_model", "pending")])),
    ).toEqual({ completeness: "incomplete", observations: [] });
  });

  it("aggregates every component across operations, in one order", () => {
    const state = applyRuntimeUsageEvidence(createRuntimeUsageAccounting(), [
      expected("text_to_speech", "output_1"),
      expected("language_model", "output_1"),
      satisfied("text_to_speech", "output_1", [
        entry("text_to_speech", "input_text", 56, "character"),
        entry("text_to_speech", "output_audio", 800, "audio_millisecond"),
      ]),
      satisfied("language_model", "output_1", [entry("language_model", "input_text", 40)]),
      expected("speech_to_text", "opportunity_1"),
      satisfied("speech_to_text", "opportunity_1", [
        entry("speech_to_text", "input_audio", 1_200, "audio_millisecond"),
      ]),
      satisfied("text_to_speech", "output_2", [
        entry("text_to_speech", "input_text", 36, "character"),
      ]),
    ]);
    expect(sealRuntimeUsage(state)).toEqual({
      completeness: "complete",
      observations: [
        entry("language_model", "input_text", 40),
        entry("speech_to_text", "input_audio", 1_200, "audio_millisecond"),
        entry("text_to_speech", "input_text", 92, "character"),
        entry("text_to_speech", "output_audio", 800, "audio_millisecond"),
      ],
    });
  });

  it("preserves prior sums and marks the aggregate incomplete on safe-integer overflow", () => {
    const state = applyRuntimeUsageEvidence(createRuntimeUsageAccounting(), [
      satisfied("speech_to_text", "first", [
        entry("speech_to_text", "input_audio", Number.MAX_SAFE_INTEGER),
      ]),
      satisfied("speech_to_text", "second", [entry("speech_to_text", "input_audio", 1)]),
    ]);
    expect(sealRuntimeUsage(state)).toEqual({
      completeness: "incomplete",
      observations: [entry("speech_to_text", "input_audio", Number.MAX_SAFE_INTEGER)],
    });
  });

  it("retains usage that settles after Transcript proof but before the usage seal", () => {
    let state = applyRuntimeUsageEvidence(createRuntimeUsageAccounting(), [
      expected("language_model", "late_usage"),
    ]);
    state = applyRuntimeUsageObservation(
      state,
      {
        kind: "transcript_digest_computed",
        revision: 1,
        digest: `sha256:${"a".repeat(64)}`,
      },
      "finalizing",
    );
    state = applyRuntimeUsageObservation(
      state,
      {
        kind: "session_activity_observed",
        at: 1,
        generation: 1,
        sequence: 2,
        usage: [
          satisfied("language_model", "late_usage", [entry("language_model", "output_text", 3)]),
        ],
      },
      "finalizing",
    );
    expect(sealRuntimeUsage(state)).toEqual({
      completeness: "complete",
      observations: [entry("language_model", "output_text", 3)],
    });
  });

  it("adds uncertainty when the execution's session closes while Live", () => {
    const state = applyRuntimeUsageObservation(
      createRuntimeUsageAccounting(),
      {
        kind: "session_closed_observed",
        at: 1,
        generation: 1,
        sequence: 1,
      },
      "live",
    );
    expect(sealRuntimeUsage(state).completeness).toBe("incomplete");
  });

  it("reconstructs only an owned durable state", () => {
    const state = createRuntimeUsageAccounting();
    expect(parseRuntimeUsageAccountingState(JSON.stringify(state))).toEqual(state);
    expect(parseRuntimeUsageAccountingState({ ...state, extra: true })).toBeNull();
    expect(parseRuntimeUsageAccountingState(Object.create(state))).toBeNull();
    expect(
      parseRuntimeUsageAccountingState({
        ...state,
        pending: [
          { componentRole: "language_model", key: "same" },
          { componentRole: "text_to_speech", key: "same" },
        ],
      }),
    ).toBeNull();
    expect(
      parseRuntimeUsageAccountingState({
        ...state,
        pending: [{ componentRole: " ", key: "blank_component" }],
      }),
    ).toBeNull();
  });
});

/** Runtime publishes only the usage the Run's combination declares. */
describe("Runtime's check of declared usage", () => {
  const declarations: readonly UsageDeclaration[] = [
    { componentRole: "language_model", provider: "openai", measure: "input_text", unit: "token" },
    { componentRole: "language_model", provider: "openai", measure: "output_text", unit: "token" },
  ];

  it("passes evidence whose entries the combination declares", () => {
    const evidence = [
      expected("language_model", "output_1"),
      satisfied("language_model", "output_1", [entry("language_model", "input_text", 40)]),
    ];
    const admitted = admitDeclaredUsage(evidence, declarations);
    expect(admitted).toBe(evidence);
    expect(
      sealRuntimeUsage(applyRuntimeUsageEvidence(createRuntimeUsageAccounting(), admitted)),
    ).toEqual({
      completeness: "complete",
      observations: [entry("language_model", "input_text", 40)],
    });
  });

  it.each([
    ["measure", { measure: "reasoning" }],
    ["unit", { unit: "character" as const }],
    ["provider", { provider: "other" }],
    ["component", { componentRole: "speech_to_text" }],
  ])("publishes no entry of an undeclared %s, and the usage as incomplete", (_, change) => {
    const declared = entry("language_model", "input_text", 40);
    const undeclared = { ...entry("language_model", "output_text", 12), ...change };
    const admitted = admitDeclaredUsage(
      [
        expected("language_model", "output_1"),
        satisfied("language_model", "output_1", [declared, undeclared]),
      ],
      declarations,
    );
    expect(
      sealRuntimeUsage(applyRuntimeUsageEvidence(createRuntimeUsageAccounting(), admitted)),
    ).toEqual({ completeness: "incomplete", observations: [declared] });
  });
});

function expected(component: string, key: string): ConversationUsageEvidence {
  return { status: "expected", componentRole: component, key: `${component}:${key}` };
}

function satisfied(
  component: string,
  key: string,
  measurements: readonly RuntimeUsageObservation[],
  options: Readonly<{ pendingKey?: string }> = {},
): ConversationUsageEvidence {
  return {
    status: "satisfied",
    componentRole: component,
    key: `${component}:${key}`,
    ...options,
    measurements,
  };
}

function entry(
  componentRole: string,
  measure: string,
  quantity: number,
  unit: RuntimeUsageObservation["unit"] = "token",
): RuntimeUsageObservation {
  return runtimeUsageObservationSchema.parse({
    componentRole,
    provider: componentRole === "language_model" ? "openai" : "soniox",
    model: `${componentRole}-model`,
    measure,
    unit,
    quantity,
  });
}
