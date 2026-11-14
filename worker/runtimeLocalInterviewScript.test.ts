import { describe, expect, it } from "vitest";
import type { LanguageModelRequest } from "./providers/cascade/adapters.ts";
import {
  standInClosing,
  standInInterviewResponse,
  standInNextQuestion,
  standInOpening,
} from "./runtimeLocalInterviewScript.ts";
import {
  goodbyeInterviewInstructions,
  questionPromptPresets,
} from "../tests/lab-content/presets.ts";

describe("Local Runtime interview script for the Cascade stand-ins", () => {
  const prompt = ["Ask only these questions:", "1. First?", "2. Second?"].join("\n");
  const request = (
    history: LanguageModelRequest["history"],
    text = prompt,
  ): LanguageModelRequest => ({
    history,
    instructions: { kind: "literal", text },
    operationalInstructions: "",
    tools: [],
    toolChoice: "auto",
    maxOutputTokens: "inf",
    reasoning: null,
  });
  const interviewer = { role: "interviewer", text: "Question" } as const;

  it("asks each numbered question, then closes and finishes after the last answer", () => {
    expect(standInInterviewResponse(request([]))).toBe(standInOpening);
    const first = [interviewer, { role: "participant", text: "Clear talks." }] as const;
    expect(standInInterviewResponse(request(first))).toEqual({ text: ["Second?"] });
    const second = [...first, interviewer, { role: "participant", text: "More breaks." }] as const;
    expect(standInInterviewResponse(request(second))).toBe(standInClosing);
    expect(standInClosing.toolCalls).toEqual([{ name: "finish_interview", arguments: "{}" }]);
  });

  it("closes when the participant asks to end, and never without numbered questions", () => {
    const stop = [
      interviewer,
      { role: "participant", text: "Please End the interview now." },
    ] as const;
    expect(standInInterviewResponse(request(stop))).toBe(standInClosing);
    const answered = [interviewer, { role: "participant", text: "Clear talks." }] as const;
    expect(standInInterviewResponse(request(answered, "Ask about the event."))).toBe(
      standInNextQuestion,
    );
  });

  it("finishes without speech when the prompt keeps the closing for its Goodbye, which speaks it", () => {
    const answered = [interviewer, { role: "participant", text: "Clear talks." }] as const;
    expect(standInInterviewResponse(request(answered, goodbyeInterviewInstructions))).toEqual({
      text: [],
      toolCalls: [{ name: "finish_interview", arguments: "{}" }],
    });
  });

  it("asks a Questions prompt's question, then calls its tool without speech after the answer", () => {
    const [first, last] = questionPromptPresets;
    if (first === undefined || last === undefined) throw new Error("Missing Questions presets");
    // Question 1 of 2 of the substitute content set: the welcome and the question, then
    // next_question.
    expect(standInInterviewResponse(request([], first))).toEqual({
      text: ["Welcome. ", "What worked well?"],
    });
    const firstAsked = {
      role: "interviewer",
      text: "Welcome. What worked well?",
    } as const;
    const answered = [firstAsked, { role: "participant", text: "Clear talks." }] as const;
    expect(standInInterviewResponse(request(answered, first))).toEqual({
      text: [],
      toolCalls: [{ name: "next_question", arguments: "{}" }],
    });
    // Question 2 opens with question 1's answer in its history: that answer is not its own, so
    // it asks its question without the welcome, then finishes after its own answer.
    expect(standInInterviewResponse(request(answered, last))).toEqual({
      text: ["What could improve?"],
    });
    const lastAnswered = [
      ...answered,
      { role: "interviewer", text: "What could improve?" },
      { role: "participant", text: "More breaks." },
    ] as const;
    expect(standInInterviewResponse(request(lastAnswered, last))).toEqual({
      text: [],
      toolCalls: [{ name: "finish_interview", arguments: "{}" }],
    });
    // A request to end on any question finishes; Goodbye speaks.
    const stop = [firstAsked, { role: "participant", text: "End the interview." }] as const;
    expect(standInInterviewResponse(request(stop, first))).toEqual({
      text: [],
      toolCalls: [{ name: "finish_interview", arguments: "{}" }],
    });
  });
});
