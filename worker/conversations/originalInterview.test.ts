import { describe, expect, it } from "vitest";
import {
  acceptConversation,
  decideConversationTransition,
} from "../runtime/admission/private/definition.ts";
import {
  consumeStateReport,
  createReportingAuthority,
  issueStateReporter,
} from "../runtime/admission/private/reporting.ts";
import {
  decodeOriginalInterviewInput,
  interpretOriginalInterviewTool,
  originalInterviewContent,
  originalInterviewConversation,
  originalInterviewStates,
} from "./originalInterview.ts";

const input = {
  contract: "original-interview-input/v1",
  interviewingDurationMs: 300_000,
  interviewing: {
    instructions: { kind: "literal", text: "  Ask why.  " },
    toolDescriptions: { finish_interview: "  Finish after the closing.  " },
  },
};
const hosted = {
  ...input,
  interviewing: {
    ...input.interviewing,
    instructions: {
      kind: "provider_prompt",
      reference: { id: "prompt", version: "2", variables: { locale: "en", turns: 3, warm: true } },
      supplementalText: "  Speak slowly.  ",
    },
  },
};
const finishParameters = { type: "object", properties: {}, additionalProperties: false };
type PrototypeFields = Readonly<{ text?: string; finish_interview?: string }>;
/** A value whose only fields are inherited from `properties`. */
function inherited(properties: PrototypeFields): object {
  const value: unknown = Object.create(properties);
  if (value === null || typeof value !== "object") throw new Error("invalid_test_prototype");
  return value;
}

describe("Original Conversation input", () => {
  it("accepts both instruction formats with their exact text", () => {
    expect(decodeOriginalInterviewInput(input)).toEqual(input);
    expect(decodeOriginalInterviewInput(hosted)).toEqual(hosted);
  });
  it("requires an owned positive integer interviewing duration", () => {
    for (const value of [undefined, null, "300000", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        decodeOriginalInterviewInput({ ...input, interviewingDurationMs: value }),
      ).toThrow();
    const { interviewingDurationMs, ...own } = input;
    expect(() =>
      decodeOriginalInterviewInput(Object.assign(Object.create({ interviewingDurationMs }), own)),
    ).toThrow();
  });
  it.each<readonly [string, unknown]>([
    ["no fields", {}],
    [
      "a numeric instruction",
      { ...input, interviewing: { ...input.interviewing, instructions: 42 } },
    ],
    [
      "blank literal instructions",
      {
        ...input,
        interviewing: { ...input.interviewing, instructions: { kind: "literal", text: "   " } },
      },
    ],
    [
      "a blank finish_interview description",
      {
        ...input,
        interviewing: { ...input.interviewing, toolDescriptions: { finish_interview: " " } },
      },
    ],
    ["another format", { ...input, contract: "interview-agent/v2" }],
    ["an unknown field", { ...input, extra: true }],
    ...[
      { kind: "provider_prompt", reference: { id: "prompt" } },
      { kind: "provider_prompt", reference: { id: "  " }, supplementalText: "" },
      { kind: "provider_prompt", reference: { id: "prompt", version: "  " }, supplementalText: "" },
      {
        kind: "provider_prompt",
        reference: { id: "prompt", variables: { locale: null } },
        supplementalText: "",
      },
      { kind: "provider_prompt", reference: { id: "prompt" }, supplementalText: 42 },
    ].map(
      (instructions) =>
        [
          `the prompt reference ${JSON.stringify(instructions)}`,
          { ...input, interviewing: { ...input.interviewing, instructions } },
        ] as const,
    ),
  ])("refuses input with %s", (_case, value) => {
    expect(() => decodeOriginalInterviewInput(value)).toThrow();
  });
  it.each([
    [
      "contract",
      Object.assign(Object.create({ contract: input.contract }), {
        interviewingDurationMs: input.interviewingDurationMs,
        interviewing: input.interviewing,
      }),
    ],
    [
      "interviewing",
      Object.assign(Object.create({ interviewing: input.interviewing }), {
        contract: input.contract,
        interviewingDurationMs: input.interviewingDurationMs,
      }),
    ],
    [
      "instructions text",
      {
        ...input,
        interviewing: {
          ...input.interviewing,
          instructions: Object.assign(inherited({ text: "Ask why." }), { kind: "literal" }),
        },
      },
    ],
    [
      "tool descriptions",
      {
        ...input,
        interviewing: {
          ...input.interviewing,
          toolDescriptions: inherited({ finish_interview: "Finish." }),
        },
      },
    ],
  ])("refuses an inherited %s", (_field, value) => {
    expect(() => decodeOriginalInterviewInput(value)).toThrow();
  });
});

describe("Original Conversation transitions", () => {
  const finish = { kind: "finish_intent", responseId: "response", toolCallId: "call" };
  const transition = (from: string, to: string) => ({
    target: to,
    terminal: to === "complete",
    diagnostics: [{ type: "conversation.transition", payload: { from, to } }],
  });
  it("finishes Interviewing on finish_intent and completes once finishing reports", () => {
    expect(
      decideConversationTransition(
        originalInterviewConversation,
        "interviewing",
        originalInterviewStates.interviewing.event.parse(finish),
        "execution",
      ),
    ).toEqual(transition("interviewing", "finishing"));
    expect(
      decideConversationTransition(
        originalInterviewConversation,
        "finishing",
        originalInterviewStates.finishing.event.parse({ kind: "output_completed" }),
        "execution",
      ),
    ).toEqual(transition("finishing", "complete"));
  });
  it.each(["interview_time_elapsed", "participant_stopped"])(
    "completes Interviewing on Runtime's %s",
    (kind) => {
      expect(
        decideConversationTransition(
          originalInterviewConversation,
          "interviewing",
          { kind },
          "runtime",
        ),
      ).toEqual(transition("interviewing", "complete"));
    },
  );
  it("bounds Interviewing from Live and finishing from its entry, with its cleanup at six seconds", () => {
    const accepted = acceptConversation(originalInterviewConversation, input);
    expect(accepted.timers?.({ liveAt: 1_000, enteredAt: 5_000, state: "interviewing" })).toEqual({
      timers: [
        { id: "interviewing", deadlineAt: 301_000, event: { kind: "interview_time_elapsed" } },
      ],
      associatedTimerId: "interviewing",
    });
    expect(accepted.timers?.({ liveAt: 1_000, enteredAt: 50_000, state: "finishing" })).toEqual({
      timers: [{ id: "finishing", deadlineAt: 60_000, event: { kind: "finishing_time_elapsed" } }],
      associatedTimerId: "finishing",
      retainedOutputCleanupAt: 56_000,
    });
  });
});

describe("what the model receives in each Original state", () => {
  const nodeInput = (value: typeof input | typeof hosted) =>
    originalInterviewStates.interviewing.input.parse(
      acceptConversation(originalInterviewConversation, value).selectInput("interviewing", {
        runId: "run",
      }),
    );
  it("sends literal instructions unchanged with the finish_interview tool and its description", () => {
    expect(originalInterviewContent.interviewing.prepare(nodeInput(input))).toEqual({
      instructions: { kind: "literal", text: "  Ask why.  " },
      operationalInstructions: "",
      tools: [
        {
          type: "function",
          name: "finish_interview",
          parameters: finishParameters,
          description: "  Finish after the closing.  ",
        },
      ],
    });
  });
  it("sends a provider prompt as the prompt with its supplemental text as operational instructions", () => {
    expect(originalInterviewContent.interviewing.prepare(nodeInput(hosted))).toEqual({
      instructions: {
        kind: "provider_prompt",
        prompt: { id: "prompt", version: "2", variables: { locale: "en", turns: 3, warm: true } },
      },
      operationalInstructions: "  Speak slowly.  ",
      tools: [
        {
          type: "function",
          name: "finish_interview",
          parameters: finishParameters,
          description: "  Finish after the closing.  ",
        },
      ],
    });
  });
  it("sends nothing in finishing, which keeps the output of the reply that finished", () => {
    expect(originalInterviewContent.finishing.prepare).toBeNull();
  });
});

describe("what a tool call means in Original Interviewing", () => {
  const identity = { runId: "run", visitId: "visit", operationId: "operation", generation: 1 };
  function reporting(current = true) {
    const authority = createReportingAuthority();
    const contract = originalInterviewStates.interviewing;
    const reporter = issueStateReporter(contract, identity, () => current, authority);
    return {
      reporter,
      read: (report: Parameters<typeof consumeStateReport>[0]) =>
        consumeStateReport(report, contract, authority),
    };
  }
  it("reads finish_interview as a request to finish, with its response and call ids", () => {
    const { reporter, read } = reporting();
    const intent = interpretOriginalInterviewTool(
      { toolName: "finish_interview", arguments: "{}", callId: "call", responseId: "response" },
      reporter,
    );
    expect(intent?.kind).toBe("conversation_event");
    expect(read(intent?.report)).toEqual({
      kind: "finish_intent",
      responseId: "response",
      toolCallId: "call",
    });
  });
  it.each(["next_question", "lookup"])("gives %s no meaning", (toolName) => {
    const { reporter } = reporting();
    expect(
      interpretOriginalInterviewTool(
        { toolName, callId: "call", responseId: "response" },
        reporter,
      ),
    ).toBeNull();
  });
  it("recognizes finish_interview without reporting it when its ids or a reporter are missing", () => {
    const { reporter } = reporting();
    expect(interpretOriginalInterviewTool({ toolName: "finish_interview" }, reporter)).toEqual({
      kind: "conversation_event",
    });
    expect(
      interpretOriginalInterviewTool({
        toolName: "finish_interview",
        callId: "call",
        responseId: "response",
      }),
    ).toEqual({ kind: "conversation_event" });
  });
  it("means nothing once the reporter's visit is no longer current", () => {
    const { reporter } = reporting(false);
    expect(
      interpretOriginalInterviewTool(
        { toolName: "finish_interview", callId: "call", responseId: "response" },
        reporter,
      ),
    ).toBeNull();
  });
});
