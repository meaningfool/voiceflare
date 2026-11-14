import { describe, expect, it } from "vitest";
import { createConversationSnapshot, decodeConversationSnapshot } from "./conversationExecution.ts";
import { prepareRealtimeSettings } from "../providers/openaiRealtime/preparedModelSession.ts";
import {
  createInterviewConversationInput,
  testInterviewInstructions,
} from "./testing/interviewConversationPreset.ts";
import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";

function accepted() {
  const execution = {
    agentInput: createInterviewConversationInput(testInterviewInstructions),
  };
  const choices = { reasoningEffort: "low" as const };
  return createConversationSnapshot(
    originalRealtimeSelection,
    execution,
    { ...choices, prepared: prepareRealtimeSettings(choices) },
    "interviewing",
  );
}
function preparedVoice(snapshot: ReturnType<typeof accepted>) {
  const prepared = snapshot.executionSettings.prepared;
  if (prepared === null || typeof prepared !== "object" || Array.isArray(prepared))
    throw new Error("missing_settings");
  const output = prepared.outputAudio;
  return output !== null && typeof output === "object" && !Array.isArray(output)
    ? output.voice
    : undefined;
}
describe("accepted Conversation persistence", () => {
  it("detaches accepted input, selection and execution settings from their callers", () => {
    const snapshot = accepted();
    const stored = JSON.stringify(snapshot);
    const restored = decodeConversationSnapshot(JSON.parse(stored));
    snapshot.selection.execution.version = 99;
    const prepared = snapshot.executionSettings.prepared;
    if (prepared === null || typeof prepared !== "object" || Array.isArray(prepared))
      throw new Error("missing_settings");
    prepared.outputAudio = { voice: "cedar", speed: 1 };
    expect(restored.selection.execution.version).toBe(1);
    expect(preparedVoice(restored)).toBe("marin");
    expect(JSON.stringify(restored)).toBe(stored);
  });
  it("refuses corrupt or unsupported current snapshot contracts before recovery", () => {
    const snapshot = accepted();
    const inheritedSelection: unknown = Object.create(snapshot.selection);
    for (const invalid of [
      {},
      { ...snapshot, version: 2 },
      { ...snapshot, initialState: 42 },
      { ...snapshot, initialState: undefined },
      { ...snapshot, execution: { agentInput: undefined } },
      {
        ...snapshot,
        selection: {
          conversation: { id: "original-interview", version: "1" },
          execution: snapshot.selection.execution,
        },
      },
      {
        ...snapshot,
        executionSettings: { ...snapshot.executionSettings, prepared: undefined },
      },
      {
        ...snapshot,
        executionSettings: { ...snapshot.executionSettings, reasoningEffort: "maximal" },
      },
      { ...snapshot, operationId: null },
      { ...snapshot, extra: true },
      Object.create(snapshot),
      { ...snapshot, selection: inheritedSelection },
    ])
      expect(() => decodeConversationSnapshot(invalid)).toThrow();
  });
});
