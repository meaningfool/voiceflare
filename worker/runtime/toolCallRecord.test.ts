import { describe, expect, it } from "vitest";
import { BoundaryValidationError } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import { decodeRuntimeToolCallPayload } from "./toolCallRecord.ts";

const ignored = {
  toolName: "next_question",
  toolCallId: "call_1",
  responseId: "resp_1",
  argumentsBytes: 2,
  state: "question",
  visitId: "visit_1",
  operationId: "operation_1",
  context: { questionIndex: 1, questionCount: 2 },
  outcome: "ignored",
  reason: "no_transition",
};

describe("Runtime tool-call record payload", () => {
  it("returns the owned payload without the Run diagnostic context Runtime adds", () => {
    expect(
      decodeRuntimeToolCallPayload(
        JSON.stringify({ ...ignored, surface: "lab", environment: "local" }),
      ),
    ).toEqual(ignored);
    const transitioned = {
      ...ignored,
      outcome: "transitioned",
      to: "goodbye",
      reason: undefined,
      context: undefined,
    };
    expect(decodeRuntimeToolCallPayload(JSON.stringify(transitioned))).toEqual({
      toolName: "next_question",
      toolCallId: "call_1",
      responseId: "resp_1",
      argumentsBytes: 2,
      state: "question",
      visitId: "visit_1",
      operationId: "operation_1",
      outcome: "transitioned",
      to: "goodbye",
    });
  });

  it.each([
    ["non-JSON text", "{"],
    ["a JSON value that is not a payload", "[]"],
    ["a missing tool name", JSON.stringify({ ...ignored, toolName: undefined })],
    ["a numeric call ID", JSON.stringify({ ...ignored, toolCallId: 7 })],
    ["negative argument bytes", JSON.stringify({ ...ignored, argumentsBytes: -1 })],
    ["a missing visit", JSON.stringify({ ...ignored, visitId: undefined })],
    ["an unknown outcome", JSON.stringify({ ...ignored, outcome: "dropped" })],
    ["an ignored call without a reason", JSON.stringify({ ...ignored, reason: undefined })],
    ["a rejection with an ignore reason", JSON.stringify({ ...ignored, outcome: "rejected" })],
    [
      "a transition without its target",
      JSON.stringify({ ...ignored, outcome: "transitioned", reason: undefined }),
    ],
  ])("rejects %s", (_case, payloadJson) => {
    expect(() => decodeRuntimeToolCallPayload(payloadJson)).toThrow(BoundaryValidationError);
  });
});
