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
import type { ConversationCallbackJson } from "../runtime/conversationContracts.ts";
import {
  assessGoodbyeInterviewClosing,
  decodeGoodbyeInterviewInput,
  goodbyeInterviewContent,
  goodbyeInterviewConversation,
  goodbyeInterviewStates,
  interpretGoodbyeInterviewTool,
} from "./goodbyeInterview.ts";

const input = () => ({
  contract: "goodbye-interview-input/v1" as const,
  interviewingDurationMs: 60_000,
  maximumClosingDurationMs: 45_000,
  interviewing: {
    instructions: { kind: "literal" as const, text: "Ask one question.\nThen finish." },
    toolDescriptions: { finish_interview: "Finish without the closing." },
  },
  goodbye: { closingSentence: "Thank you. Goodbye." },
});
const identity = { runId: "run", visitId: "visit", operationId: "operation", generation: 1 };

describe("Goodbye Conversation input", () => {
  it("accepts a complete input and gives each node its own part, detached", () => {
    const value = input();
    expect(decodeGoodbyeInterviewInput(value)).toEqual(input());
    const accepted = acceptConversation(goodbyeInterviewConversation, value);
    const goodbye = accepted.selectInput("goodbye", { runId: "run" });
    value.goodbye.closingSentence = "";
    expect(goodbye).toEqual({ closingSentence: "Thank you. Goodbye." });
    expect(accepted.selectInput("interviewing", { runId: "run" })).toEqual({
      instructions: { kind: "literal", text: "Ask one question.\nThen finish." },
      toolDescriptions: { finish_interview: "Finish without the closing." },
    });
  });
  it.each(["interviewingDurationMs", "maximumClosingDurationMs"] as const)(
    "requires an owned bounded %s",
    (field) => {
      for (const value of [undefined, null, "45000", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
        expect(() => decodeGoodbyeInterviewInput({ ...input(), [field]: value })).toThrow();
      const own: Partial<ReturnType<typeof input>> = { ...input() };
      Reflect.deleteProperty(own, field);
      expect(() =>
        decodeGoodbyeInterviewInput(Object.assign(Object.create({ [field]: input()[field] }), own)),
      ).toThrow();
    },
  );
  it.each([
    ["no input", null],
    ["only its format", { contract: "goodbye-interview-input/v1" }],
    ["a numeric closing sentence", { ...input(), goodbye: { closingSentence: 42 } }],
    ["a blank closing sentence", { ...input(), goodbye: { closingSentence: "  " } }],
    [
      "Goodbye instructions in place of its closing sentence",
      { ...input(), goodbye: { instructions: "Say only: Thank you. Goodbye." } },
    ],
    [
      "Goodbye instructions beside its closing sentence",
      {
        ...input(),
        goodbye: { closingSentence: "Thank you. Goodbye.", instructions: "Say it verbatim." },
      },
    ],
    [
      "a numeric finish_interview description",
      {
        ...input(),
        interviewing: { ...input().interviewing, toolDescriptions: { finish_interview: 42 } },
      },
    ],
    ["another format", { ...input(), contract: "questions-interview-input/v1" }],
    ["an unknown field", { ...input(), unknown: "unexpected" }],
    ["inherited fields", Object.create(input())],
  ])("refuses input with %s", (_case, value) => {
    expect(() => decodeGoodbyeInterviewInput(value)).toThrow();
  });
});

describe("Goodbye Conversation transitions", () => {
  const transition = (from: string, to: string) => ({
    target: to,
    terminal: to === "complete",
    diagnostics: [{ type: "conversation.transition", payload: { from, to } }],
  });
  const decide = (
    state: string,
    event: ConversationCallbackJson,
    origin: "execution" | "runtime",
  ) => decideConversationTransition(goodbyeInterviewConversation, state, event, origin);
  it("moves Interviewing to Goodbye on finish_intent and on the interview deadline", () => {
    const finish = goodbyeInterviewStates.interviewing.event.parse({
      kind: "finish_intent",
      responseId: "response",
      toolCallId: "call",
    });
    expect(decide("interviewing", finish, "execution")).toEqual(
      transition("interviewing", "goodbye"),
    );
    expect(decide("interviewing", { kind: "interview_time_elapsed" }, "runtime")).toEqual(
      transition("interviewing", "goodbye"),
    );
  });
  it.each(["participant_stopped", "closing_time_elapsed"])(
    "completes Interviewing on Runtime's %s",
    (kind) => {
      expect(decide("interviewing", { kind }, "runtime")).toEqual(
        transition("interviewing", "complete"),
      );
    },
  );
  it("completes Goodbye on its closing, Stop or the closing deadline, never on a late interview deadline", () => {
    const completed = goodbyeInterviewStates.goodbye.event.parse({
      kind: "goodbye_completed",
      responseId: "closing",
    });
    expect(decide("goodbye", completed, "execution")).toEqual(transition("goodbye", "complete"));
    for (const kind of ["participant_stopped", "closing_time_elapsed"])
      expect(decide("goodbye", { kind }, "runtime")).toEqual(transition("goodbye", "complete"));
    expect(() => decide("goodbye", { kind: "interview_time_elapsed" }, "runtime")).toThrow(
      "conversation_event_state_invalid",
    );
  });
  it("bounds Interviewing from Live and Goodbye by the closing duration from its entry", () => {
    const accepted = acceptConversation(goodbyeInterviewConversation, input());
    expect(accepted.timers?.({ liveAt: 1_000, enteredAt: 1_000, state: "interviewing" })).toEqual({
      timers: [
        { id: "interviewing", deadlineAt: 61_000, event: { kind: "interview_time_elapsed" } },
      ],
      associatedTimerId: "interviewing",
    });
    expect(accepted.timers?.({ liveAt: 1_000, enteredAt: 70_000, state: "goodbye" })).toEqual({
      timers: [{ id: "closing", deadlineAt: 115_000, event: { kind: "closing_time_elapsed" } }],
      associatedTimerId: "closing",
    });
  });
  it("does not let execution report Runtime-only expiry", () => {
    const reporter = issueStateReporter<ConversationCallbackJson>(
      goodbyeInterviewStates.interviewing,
      identity,
      () => true,
      createReportingAuthority(),
    );
    expect(() => reporter.report({ kind: "interview_time_elapsed" })).toThrow();
  });
});

describe("what each Goodbye state says", () => {
  const accepted = () => acceptConversation(goodbyeInterviewConversation, input());
  it("sends Interviewing's literal instructions with the finish_interview tool and its description", () => {
    const node = goodbyeInterviewStates.interviewing.input.parse(
      accepted().selectInput("interviewing", { runId: "run" }),
    );
    expect(goodbyeInterviewContent.interviewing.prepare(node)).toEqual({
      instructions: { kind: "literal", text: "Ask one question.\nThen finish." },
      operationalInstructions: "",
      tools: [
        {
          type: "function",
          name: "finish_interview",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          description: "Finish without the closing.",
        },
      ],
    });
  });
  it("is the closing sentence in Goodbye", () => {
    const node = goodbyeInterviewStates.goodbye.input.parse(
      accepted().selectInput("goodbye", { runId: "run" }),
    );
    expect(goodbyeInterviewContent.goodbye.prepare(node)).toEqual({
      sentence: "Thank you. Goodbye.",
    });
  });
});

describe("what a tool call means in Goodbye's Interviewing", () => {
  function reporting(current = true) {
    const authority = createReportingAuthority();
    const contract = goodbyeInterviewStates.interviewing;
    return {
      reporter: issueStateReporter(contract, identity, () => current, authority),
      read: (report: Parameters<typeof consumeStateReport>[0]) =>
        consumeStateReport(report, contract, authority),
    };
  }
  it("reads finish_interview as a request to finish, with its response and call ids", () => {
    const { reporter, read } = reporting();
    const intent = interpretGoodbyeInterviewTool(
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
      interpretGoodbyeInterviewTool({ toolName, callId: "call", responseId: "response" }, reporter),
    ).toBeNull();
  });
  it("recognizes finish_interview without reporting it when its ids or a reporter are missing", () => {
    const { reporter } = reporting();
    expect(interpretGoodbyeInterviewTool({ toolName: "finish_interview" }, reporter)).toEqual({
      kind: "conversation_event",
    });
    expect(
      interpretGoodbyeInterviewTool({
        toolName: "finish_interview",
        callId: "call",
        responseId: "response",
      }),
    ).toEqual({ kind: "conversation_event" });
  });
  it("means nothing once the reporter's visit is no longer current", () => {
    const { reporter } = reporting(false);
    expect(
      interpretGoodbyeInterviewTool(
        { toolName: "finish_interview", callId: "call", responseId: "response" },
        reporter,
      ),
    ).toBeNull();
  });
});

describe("Goodbye's closing assessment", () => {
  it("records the end and keeps only the closing limitations among the warnings, in order", () => {
    expect(
      assessGoodbyeInterviewClosing({
        warnings: ["closing_interrupted", "transcript_incomplete", "closing_cutoff_exhausted"],
        finalizedAt: 2_100,
        endReason: "timebox_reached",
      }),
    ).toEqual([
      {
        type: "conversation.closing_assessment",
        payload: {
          warnings: ["closing_interrupted", "closing_cutoff_exhausted"],
          finalizedAt: 2_100,
          endReason: "timebox_reached",
        },
      },
    ]);
  });
  it("records an explicit empty warning list for a clean closing", () => {
    expect(
      assessGoodbyeInterviewClosing({
        warnings: [],
        finalizedAt: 0,
        endReason: "agent_requested_end",
      }),
    ).toEqual([
      {
        type: "conversation.closing_assessment",
        payload: { warnings: [], finalizedAt: 0, endReason: "agent_requested_end" },
      },
    ]);
  });
});
