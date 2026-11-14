/**
 * Runtime's own sample interview content for its Goodbye and Questions tests, so that editing a
 * Lab preset changes no Runtime test. No model receives it: the tests run on controlled
 * providers. The local Runtime's interview script (`worker/runtimeLocalInterviewScript.ts`)
 * reads its shape: the Goodbye instructions number their one question ("1. ") and keep the
 * closing for the "dedicated closing response", and each Question's prompt names its question
 * on the line after "Current question: N of M". The text was taken from Lab's presets as they
 * were when Runtime's tests stopped reading them; the two may now differ.
 */

export const sampleGoodbyeInterviewInstructions = [
  "Conduct this participant feedback interview in English.",
  "Use this interview flow as the source of truth.",
  "Begin with the Warm-up and the first question together in one spoken turn.",
  "Warm-up — utter this first, verbatim:",
  "Welcome.",
  "Ask only these questions, exactly as written, in this order:",
  "1. What worked well at the event?",
  "After each participant answer, ask the next question in one spoken turn. Do not add commentary, follow-up questions, or requests for clarification.",
  "End the response after each question and wait for the participant's answer before continuing.",
  "Closing message for the dedicated closing response — do not utter this before calling finish_interview:",
  "Thank you. Goodbye.",
].join("\n");

export const sampleFinishDescription = `End the interview when the participant asks to stop, even if questions
remain, or after the final question and any needed follow-ups have
been answered.

Call this tool without uttering the closing message. The configured closing
message will be requested in a separate response.

Do not ask another question or request confirmation.`;

/** The closing sentence Goodbye says. */
export const sampleClosingSentence = "Thank you. Goodbye.";

/** Two Questions, the first and the last. */
export const sampleQuestionPrompts: readonly [string, string] = [
  'Conduct this participant feedback interview in English.\nCurrent question: 1 of 2\nWhat worked well at the event?\n\nOn the first question, say "Welcome." once, then ask the question exactly as written.\nOn later questions, ask the question exactly as written without repeating the welcome.\nWait for the participant\'s answer.\n\nUse earlier answers as context. Ask at most one brief follow-up if a relevant detail needs clarification. Ask one question at a time, then wait for the answer.\n\nOnce this question and any follow-up are answered, call next_question if another question remains; otherwise call finish_interview.\nIf the participant asks to stop, call finish_interview immediately.\nDo not choose or ask a later question yourself.\nDo not speak in a response that calls either tool.',
  'Conduct this participant feedback interview in English.\nCurrent question: 2 of 2\nWhat could improve at the event?\n\nOn the first question, say "Welcome." once, then ask the question exactly as written.\nOn later questions, ask the question exactly as written without repeating the welcome.\nWait for the participant\'s answer.\n\nUse earlier answers as context. Ask at most one brief follow-up if a relevant detail needs clarification. Ask one question at a time, then wait for the answer.\n\nOnce this question and any follow-up are answered, call next_question if another question remains; otherwise call finish_interview.\nIf the participant asks to stop, call finish_interview immediately.\nDo not choose or ask a later question yourself.\nDo not speak in a response that calls either tool.',
];

export const sampleNextQuestionDescription =
  "Request the next configured question after the current question and any needed follow-up have been answered.\nCall only when another question remains. Do not choose, announce, or ask the next question.\nIf the participant asks to stop, or the final question is complete, call finish_interview.\nDo not ask for confirmation.";

type Durations = Readonly<{ interviewingDurationMs?: number; maximumClosingDurationMs?: number }>;

/** A Goodbye interview input on the sample content. */
export function sampleGoodbyeInput(durations: Durations = {}) {
  return {
    contract: "goodbye-interview-input/v1" as const,
    interviewingDurationMs: durations.interviewingDurationMs ?? 300_000,
    maximumClosingDurationMs: durations.maximumClosingDurationMs ?? 45_000,
    interviewing: {
      instructions: { kind: "literal" as const, text: sampleGoodbyeInterviewInstructions },
      toolDescriptions: { finish_interview: sampleFinishDescription },
    },
    goodbye: { closingSentence: sampleClosingSentence },
  };
}

/** A Questions interview input asking these prompts, with the sample tool descriptions. */
export function sampleQuestionsInput(questions: readonly string[], durations: Durations = {}) {
  return {
    contract: "questions-interview-input/v1" as const,
    interviewingDurationMs: durations.interviewingDurationMs ?? 300_000,
    maximumClosingDurationMs: durations.maximumClosingDurationMs ?? 45_000,
    questions: questions.map((text) => ({
      instructions: { kind: "literal" as const, text },
      toolDescriptions: {
        next_question: sampleNextQuestionDescription,
        finish_interview: sampleFinishDescription,
      },
    })),
    goodbye: { closingSentence: sampleClosingSentence },
  };
}
