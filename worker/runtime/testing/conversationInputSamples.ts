import type { InterviewExecution } from "../../shared/contracts/runtimeStart.ts";

/**
 * One complete Conversation input per input format, keyed by the format a catalog entry
 * declares as its `inputContract`. This is Runtime's own test content, not Lab's presets:
 * it only has to be a valid input of its format, and no model receives it.
 */
export const conversationInputSamples: Readonly<Record<string, InterviewExecution["agentInput"]>> =
  Object.freeze({
    "original-interview-input/v1": {
      contract: "original-interview-input/v1",
      interviewingDurationMs: 60_000,
      interviewing: {
        instructions: { kind: "literal", text: "Sample interviewing instructions." },
        toolDescriptions: { finish_interview: "Sample finish description." },
      },
    },
    "goodbye-interview-input/v1": {
      contract: "goodbye-interview-input/v1",
      interviewingDurationMs: 60_000,
      maximumClosingDurationMs: 45_000,
      interviewing: {
        instructions: { kind: "literal", text: "Sample interviewing instructions." },
        toolDescriptions: { finish_interview: "Sample finish description." },
      },
      goodbye: { closingSentence: "Thank you. Goodbye." },
    },
    "questions-interview-input/v1": {
      contract: "questions-interview-input/v1",
      interviewingDurationMs: 60_000,
      maximumClosingDurationMs: 45_000,
      questions: [
        {
          instructions: { kind: "literal", text: "Sample first question instructions." },
          toolDescriptions: {
            next_question: "Sample next question description.",
            finish_interview: "Sample finish description.",
          },
        },
        {
          instructions: { kind: "literal", text: "Sample second question instructions." },
          toolDescriptions: {
            next_question: "Sample next question description.",
            finish_interview: "Sample finish description.",
          },
        },
      ],
      goodbye: { closingSentence: "Thank you. Goodbye." },
    },
  });
