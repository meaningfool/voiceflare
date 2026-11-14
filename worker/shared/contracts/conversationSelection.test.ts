import { expect, it } from "vitest";
import {
  decodeConversationInputCheck,
  decodeConversationInputRefusal,
  missingCredentialsRefusal,
  originalRealtimeSelection,
} from "./conversationSelection.ts";

const agentInput = { contract: "original-interview-input/v1", nested: [1, "two", null] };

it("decodes a catalog input check, keeping its input opaque", () => {
  expect(
    decodeConversationInputCheck({ selection: originalRealtimeSelection, agentInput }),
  ).toEqual({ selection: originalRealtimeSelection, agentInput });
  const inheritedExtra: unknown = Object.assign(Object.create({ extra: true }), {
    selection: originalRealtimeSelection,
    agentInput,
  });
  expect(decodeConversationInputCheck(inheritedExtra)).toStrictEqual({
    selection: originalRealtimeSelection,
    agentInput,
  });
  const executionSettings = { model: "any-model", nested: { voice: "any-voice" } };
  expect(
    decodeConversationInputCheck({
      selection: originalRealtimeSelection,
      agentInput,
      executionSettings,
    }),
  ).toEqual({ selection: originalRealtimeSelection, agentInput, executionSettings });
});
it.each([
  { agentInput },
  { selection: originalRealtimeSelection },
  { selection: { conversation: { id: "original-interview" } }, agentInput },
  { selection: { ...originalRealtimeSelection, extra: true }, agentInput },
  { selection: originalRealtimeSelection, agentInput, extra: true },
  Object.assign(Object.create({ selection: originalRealtimeSelection }), { agentInput }),
])("refuses a missing, malformed, unknown or inherited check field: %j", (value) => {
  expect(() => decodeConversationInputCheck(value)).toThrow();
});
it("decodes Runtime's refusal of a check to its code", () => {
  expect(decodeConversationInputRefusal({ error: "invalid_conversation_input" })).toBe(
    "invalid_conversation_input",
  );
  expect(decodeConversationInputRefusal({ error: "conversation_selection_unavailable" })).toBe(
    "conversation_selection_unavailable",
  );
  expect(decodeConversationInputRefusal({ error: "invalid_execution_settings" })).toBe(
    "invalid_execution_settings",
  );
  expect(
    decodeConversationInputRefusal({ error: missingCredentialsRefusal(["SONIOX_API_KEY"]) }),
  ).toBe("missing_credentials:SONIOX_API_KEY");
  expect(
    decodeConversationInputRefusal({
      error: missingCredentialsRefusal(["OPENAI_API_KEY", "SONIOX_API_KEY"]),
    }),
  ).toBe("missing_credentials:OPENAI_API_KEY,SONIOX_API_KEY");
});
it.each([
  {},
  { error: 42 },
  { error: "invalid_conversation_input_check" },
  { error: "invalid_conversation_input", extra: true },
  { error: "missing_credentials:" },
  { error: "missing_credentials:openai_api_key" },
  { error: "missing_credentials:OPENAI_API_KEY," },
  { error: "missing_credentials:OPENAI_API_KEY extra" },
  Object.create({ error: "invalid_conversation_input" }),
])("refuses an unknown, malformed or inherited refusal: %j", (value) => {
  expect(() => decodeConversationInputRefusal(value)).toThrow();
});
