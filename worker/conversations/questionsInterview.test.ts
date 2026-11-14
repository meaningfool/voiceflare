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
  assessQuestionsInterviewClosing,
  decodeQuestionsInterviewInput,
  interpretQuestionsInterviewTool,
  questionsInterviewContent,
  questionsInterviewConversation,
  questionsInterviewStates,
} from "./questionsInterview.ts";

const question = (text: string) => ({
  instructions: { kind: "literal" as const, text },
  toolDescriptions: { next_question: "Move on.", finish_interview: "Finish." },
});
const input = () => ({
  contract: "questions-interview-input/v1" as const,
  interviewingDurationMs: 180_000,
  maximumClosingDurationMs: 45_000,
  questions: [question("Ask the first question."), question("Ask the second question.")],
  goodbye: { closingSentence: "Thank you. Goodbye." },
});
const first = { questionIndex: 0, questionCount: 2 };
const last = { questionIndex: 1, questionCount: 2 };
const transitionDiagnostic = (from: string, to: string, questionIndex: number) => ({
  type: "conversation.transition",
  payload: { from, to, questionIndex },
});
/** An execution report, decoded by its state's contract at capture, then decided. */
function report(
  state: keyof typeof questionsInterviewStates,
  event: ConversationCallbackJson,
  context: ConversationCallbackJson,
) {
  const accepted = questionsInterviewStates[state].event.parse(event);
  return decideConversationTransition(
    questionsInterviewConversation,
    state,
    accepted,
    "execution",
    context,
  );
}
const elapse = (state: string, kind: string, context: ConversationCallbackJson) =>
  decideConversationTransition(questionsInterviewConversation, state, { kind }, "runtime", context);

describe("Questions Conversation input", () => {
  it("accepts a complete input and starts at the first of its questions", () => {
    expect(decodeQuestionsInterviewInput(input())).toEqual(input());
    expect(acceptConversation(questionsInterviewConversation, input()).initialContext).toEqual(
      first,
    );
  });
  it.each([
    ["no questions", { ...input(), questions: [] }],
    ["more than 16 questions", { ...input(), questions: Array(17).fill(question("Ask.")) }],
    ["a blank question", { ...input(), questions: [question("  ")] }],
    [
      "a question without its next_question description",
      {
        ...input(),
        questions: [
          {
            instructions: { kind: "literal", text: "Ask." },
            toolDescriptions: { finish_interview: "Finish." },
          },
        ],
      },
    ],
    ["a blank closing sentence", { ...input(), goodbye: { closingSentence: " " } }],
    [
      "Goodbye instructions in place of its closing sentence",
      { ...input(), goodbye: { instructions: "Say goodbye." } },
    ],
    ["no goodbye", { ...input(), goodbye: undefined }],
    ["another format", { ...input(), contract: "goodbye-interview-input/v1" }],
    ["a non-integer duration", { ...input(), interviewingDurationMs: 1.5 }],
    ["a zero closing duration", { ...input(), maximumClosingDurationMs: 0 }],
    ["an unknown field", { ...input(), unknown: true }],
    ["inherited fields", Object.create(input())],
  ])("refuses input with %s", (_case, value) => {
    expect(() => decodeQuestionsInterviewInput(value)).toThrow();
  });
});

describe("Questions Conversation node input and timers", () => {
  it("gives each question node its own question and the goodbye node its closing sentence", () => {
    const accepted = acceptConversation(questionsInterviewConversation, input());
    expect(accepted.selectInput("question", { runId: "run", context: last })).toEqual(
      question("Ask the second question."),
    );
    expect(accepted.selectInput("goodbye", { runId: "run", context: last })).toEqual({
      closingSentence: "Thank you. Goodbye.",
    });
  });
  it.each([
    ["a question count other than the input's", { questionIndex: 0, questionCount: 3 }],
    ["a position past the last question", { questionIndex: 2, questionCount: 2 }],
  ])("refuses a stored position with %s", (_case, context) => {
    const accepted = acceptConversation(questionsInterviewConversation, input());
    expect(() => accepted.selectInput("question", { runId: "run", context })).toThrow();
  });
  it("bounds questions by the interview deadline from Live and goodbye by the closing deadline from its entry", () => {
    const accepted = acceptConversation(questionsInterviewConversation, input());
    expect(accepted.timers?.({ liveAt: 1_000, enteredAt: 5_000, state: "question" })).toEqual({
      timers: [
        { id: "interviewing", deadlineAt: 181_000, event: { kind: "interview_time_elapsed" } },
      ],
      associatedTimerId: "interviewing",
    });
    expect(accepted.timers?.({ liveAt: 1_000, enteredAt: 90_000, state: "goodbye" })).toEqual({
      timers: [{ id: "closing", deadlineAt: 135_000, event: { kind: "closing_time_elapsed" } }],
      associatedTimerId: "closing",
    });
  });
});

describe("Questions Conversation transitions", () => {
  const ids = { responseId: "response", toolCallId: "call" };
  it("moves to the next question on next_question", () => {
    expect(report("question", { kind: "next_question", ...ids }, first)).toEqual({
      target: "question",
      terminal: false,
      context: last,
      diagnostics: [transitionDiagnostic("question", "question", 1)],
    });
  });
  it("keeps the last question on next_question", () => {
    expect(report("question", { kind: "next_question", ...ids }, last)).toEqual({
      target: null,
      terminal: false,
      context: last,
      diagnostics: [],
    });
  });
  it("moves to goodbye on finish_intent from any question", () => {
    expect(report("question", { kind: "finish_intent", ...ids }, first)).toEqual({
      target: "goodbye",
      terminal: false,
      context: first,
      diagnostics: [transitionDiagnostic("question", "goodbye", 0)],
    });
  });
  it("refuses a goodbye report while a question is current", () => {
    expect(() =>
      report("question", { kind: "goodbye_completed", responseId: "response" }, first),
    ).toThrow();
  });
  it.each([
    ["interview_time_elapsed", "goodbye", false],
    ["closing_time_elapsed", "complete", true],
    ["participant_stopped", "complete", true],
  ])("moves a question on Runtime's %s to %s", (kind, target, terminal) => {
    expect(elapse("question", kind, last)).toEqual({
      target,
      terminal,
      context: last,
      diagnostics: [transitionDiagnostic("question", target, 1)],
    });
  });
  it("completes when goodbye reports its closing", () => {
    expect(report("goodbye", { kind: "goodbye_completed", responseId: "response" }, last)).toEqual({
      target: "complete",
      terminal: true,
      context: last,
      diagnostics: [transitionDiagnostic("goodbye", "complete", 1)],
    });
  });
  // Unlike the Goodbye Conversation's goodbye state, which refuses a late interview deadline
  // with conversation_event_state_invalid, Questions' goodbye completes on any event.
  it.each(["interview_time_elapsed", "closing_time_elapsed", "participant_stopped"])(
    "completes goodbye on Runtime's %s, a late interview deadline included",
    (kind) => {
      expect(elapse("goodbye", kind, last)).toEqual({
        target: "complete",
        terminal: true,
        context: last,
        diagnostics: [transitionDiagnostic("goodbye", "complete", 1)],
      });
    },
  );
  it("refuses events once the interview is complete", () => {
    expect(() => elapse("complete", "participant_stopped", last)).toThrow(
      "conversation_event_state_invalid",
    );
  });
});

describe("what each Questions state says", () => {
  const accepted = () => acceptConversation(questionsInterviewConversation, input());
  const toolParameters = { type: "object", properties: {}, additionalProperties: false };
  it("sends the current question's literal prompt with next_question and finish_interview", () => {
    const node = questionsInterviewStates.question.input.parse(
      accepted().selectInput("question", { runId: "run", context: last }),
    );
    expect(questionsInterviewContent.question.prepare(node)).toEqual({
      instructions: { kind: "literal", text: "Ask the second question." },
      operationalInstructions: "",
      tools: [
        {
          type: "function",
          name: "next_question",
          parameters: toolParameters,
          description: "Move on.",
        },
        {
          type: "function",
          name: "finish_interview",
          parameters: toolParameters,
          description: "Finish.",
        },
      ],
    });
  });
  it("is the closing sentence in Goodbye", () => {
    const node = questionsInterviewStates.goodbye.input.parse(
      accepted().selectInput("goodbye", { runId: "run", context: last }),
    );
    expect(questionsInterviewContent.goodbye.prepare(node)).toEqual({
      sentence: "Thank you. Goodbye.",
    });
  });
});

describe("what a tool call means in a Question", () => {
  const identity = { runId: "run", visitId: "visit", operationId: "operation", generation: 1 };
  function reporting(current = true) {
    const authority = createReportingAuthority();
    const contract = questionsInterviewStates.question;
    return {
      reporter: issueStateReporter(contract, identity, () => current, authority),
      read: (report: Parameters<typeof consumeStateReport>[0]) =>
        consumeStateReport(report, contract, authority),
    };
  }
  it.each([
    ["next_question", "next_question"],
    ["finish_interview", "finish_intent"],
  ])("reads %s as %s, with its response and call ids", (toolName, kind) => {
    const { reporter, read } = reporting();
    const intent = interpretQuestionsInterviewTool(
      { toolName, arguments: "{}", callId: "call", responseId: "response" },
      reporter,
    );
    expect(intent?.kind).toBe("conversation_event");
    expect(read(intent?.report)).toEqual({ kind, responseId: "response", toolCallId: "call" });
  });
  it("gives any other tool no meaning", () => {
    const { reporter } = reporting();
    expect(
      interpretQuestionsInterviewTool(
        { toolName: "lookup", callId: "call", responseId: "response" },
        reporter,
      ),
    ).toBeNull();
  });
  it("recognizes its tools without reporting them when their ids or a reporter are missing", () => {
    const { reporter } = reporting();
    expect(interpretQuestionsInterviewTool({ toolName: "next_question" }, reporter)).toEqual({
      kind: "conversation_event",
    });
    expect(
      interpretQuestionsInterviewTool({
        toolName: "finish_interview",
        callId: "call",
        responseId: "response",
      }),
    ).toEqual({ kind: "conversation_event" });
  });
  it("means nothing once the reporter's visit is no longer current", () => {
    const { reporter } = reporting(false);
    expect(
      interpretQuestionsInterviewTool(
        { toolName: "next_question", callId: "call", responseId: "response" },
        reporter,
      ),
    ).toBeNull();
  });
});

describe("Questions' closing assessment", () => {
  it("records the end and keeps only the closing limitations among the warnings, in order", () => {
    expect(
      assessQuestionsInterviewClosing({
        warnings: ["closing_response_failed", "usage_unavailable", "closing_recovery_uncertain"],
        finalizedAt: 9_000,
        endReason: "agent_requested_end",
      }),
    ).toEqual([
      {
        type: "conversation.closing_assessment",
        payload: {
          warnings: ["closing_response_failed", "closing_recovery_uncertain"],
          finalizedAt: 9_000,
          endReason: "agent_requested_end",
        },
      },
    ]);
  });
});
