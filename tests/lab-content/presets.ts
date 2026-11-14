/**
 * A substitute for Lab's presets (`src/apps/lab/content/presets.ts`): the same exports with other
 * texts, so a test can run Lab on content that is not its own.
 */

/** Original's `finish_interview` description. */
export const defaultFinishInterviewDescription = `End the interview when the participant asks to stop, even if questions
remain, or after the final question and any needed follow-ups have
been answered.

IMPORTANT: Utter the closing message provided in the prompt verbatim (no addition or rephrasing), then call this
tool in the same response.

Do not ask another question or request confirmation.`;

/** Goodbye's interviewing instructions. */
export const goodbyeInterviewInstructions = [
  "Conduct this participant feedback interview in English.",
  "Use this interview flow as the source of truth.",
  "Begin with the Warm-up and the first question together in one spoken turn.",
  "Warm-up — utter this first, verbatim:",
  "Welcome.",
  "Ask only these questions, exactly as written, in this order:",
  "1. What worked well?",
  "After each participant answer, ask the next question in one spoken turn. Do not add commentary, follow-up questions, or requests for clarification.",
  "End the response after each question and wait for the participant's answer before continuing.",
  "Closing message for the dedicated closing response — do not utter this before calling finish_interview:",
  "Thank you for your feedback. Goodbye.",
].join("\n");

/** The `finish_interview` description of Goodbye and Questions. */
export const goodbyeFinishDescription = `End the interview when the participant asks to stop, even if questions
remain, or after the final question and any needed follow-ups have
been answered.

Call this tool without uttering the closing message. The configured closing
message will be requested in a separate response.

Do not ask another question or request confirmation.`;

/** The sentence Goodbye says to close, which no model generates. */
export const defaultClosingSentence = "Thank you for your feedback. Goodbye.";

/** One prompt for each question of Questions, in order. */
export const questionPromptPresets = [
  'Conduct this participant feedback interview in English.\nCurrent question: 1 of 2\nWhat worked well?\n\nOn the first question, say "Welcome." once, then ask the question exactly as written.\nOn later questions, ask the question exactly as written without repeating the welcome.\nWait for the participant\'s answer.\n\nUse earlier answers as context. Ask at most one brief follow-up if a relevant detail needs clarification. Ask one question at a time, then wait for the answer.\n\nOnce this question and any follow-up are answered, call next_question if another question remains; otherwise call finish_interview.\nIf the participant asks to stop, call finish_interview immediately.\nDo not choose or ask a later question yourself.\nDo not speak in a response that calls either tool.',
  'Conduct this participant feedback interview in English.\nCurrent question: 2 of 2\nWhat could improve?\n\nOn the first question, say "Welcome." once, then ask the question exactly as written.\nOn later questions, ask the question exactly as written without repeating the welcome.\nWait for the participant\'s answer.\n\nUse earlier answers as context. Ask at most one brief follow-up if a relevant detail needs clarification. Ask one question at a time, then wait for the answer.\n\nOnce this question and any follow-up are answered, call next_question if another question remains; otherwise call finish_interview.\nIf the participant asks to stop, call finish_interview immediately.\nDo not choose or ask a later question yourself.\nDo not speak in a response that calls either tool.',
];

/** The `next_question` description of every question. */
export const nextQuestionDescription =
  "Request the next configured question after the current question and any needed follow-up have been answered.\nCall only when another question remains. Do not choose, announce, or ask the next question.\nIf the participant asks to stop, or the final question is complete, call finish_interview.\nDo not ask for confirmation.";
