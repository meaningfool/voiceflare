import { defaultFinishInterviewDescription } from "../content/presets.ts";

/** A field the Conversation's input requires: present and not blank. */
function complete(text: string | undefined): text is string {
  return text !== undefined && text.trim().length > 0;
}

export function createInterviewConversationInput(
  instructions: string | undefined,
  finishDescription: string | undefined = defaultFinishInterviewDescription,
  interviewingDurationMs = 300_000,
) {
  if (!complete(instructions)) throw new Error("blank_raw_instructions");
  if (!complete(finishDescription)) throw new Error("blank_finish_interview_description");
  return {
    contract: "original-interview-input/v1" as const,
    interviewingDurationMs,
    interviewing: {
      instructions: { kind: "literal" as const, text: instructions },
      toolDescriptions: { finish_interview: finishDescription },
    },
  };
}

export function createGoodbyeConversationInput(
  instructions: string | undefined,
  finishDescription: string | undefined,
  closingSentence: string | undefined,
  interviewingDurationMs = 300_000,
  maximumClosingDurationMs = 45_000,
) {
  if (!complete(instructions) || !complete(finishDescription) || !complete(closingSentence))
    throw new Error("missing_goodbye_input");
  return {
    contract: "goodbye-interview-input/v1" as const,
    interviewingDurationMs,
    maximumClosingDurationMs,
    interviewing: {
      instructions: { kind: "literal" as const, text: instructions },
      toolDescriptions: { finish_interview: finishDescription },
    },
    goodbye: { closingSentence },
  };
}

export function createQuestionsConversationInput(
  questions: readonly string[] | undefined,
  nextDescription: string | undefined,
  finishDescription: string | undefined,
  closingSentence: string | undefined,
  interviewingDurationMs = 300_000,
  maximumClosingDurationMs = 45_000,
) {
  if (
    questions === undefined ||
    questions.length === 0 ||
    questions.length > 16 ||
    !questions.every(complete) ||
    !complete(nextDescription) ||
    !complete(finishDescription) ||
    !complete(closingSentence)
  )
    throw new Error("missing_questions_input");
  return {
    contract: "questions-interview-input/v1" as const,
    interviewingDurationMs,
    maximumClosingDurationMs,
    questions: questions.map((text) => ({
      instructions: { kind: "literal" as const, text },
      toolDescriptions: { next_question: nextDescription, finish_interview: finishDescription },
    })),
    goodbye: { closingSentence },
  };
}

/** The Lab settings a Conversation's interview input is built from. */
export type LabInterviewInputFields = Readonly<{
  instructions?: string | undefined;
  finishInterviewDescription?: string | undefined;
  questionPrompts?: readonly string[] | undefined;
  nextQuestionDescription?: string | undefined;
  closingSentence?: string | undefined;
  maximumClosingDurationMs?: number | undefined;
  /** The interviewing duration. */
  maxDurationMs: number;
}>;
export type LabInterviewInput =
  | ReturnType<typeof createInterviewConversationInput>
  | ReturnType<typeof createGoodbyeConversationInput>
  | ReturnType<typeof createQuestionsConversationInput>;
/** One Conversation's interview-input builder, which both Lab clients and its Lab editor use. */
export type LabInterviewInputBuilder = Readonly<{
  /** The input format the builder makes, which the Conversation's catalog entries accept. */
  inputContract: LabInterviewInput["contract"];
  /** Whether the Conversation closes with a Goodbye under its own maximum closing duration. */
  closingLimit: boolean;
  /** The Conversation's input; incomplete fields are refused with a clear error, never filled. */
  build(fields: LabInterviewInputFields): LabInterviewInput;
}>;
export const originalInterviewInputBuilder: LabInterviewInputBuilder = {
  inputContract: "original-interview-input/v1",
  closingLimit: false,
  build: (fields) =>
    createInterviewConversationInput(
      fields.instructions,
      fields.finishInterviewDescription,
      fields.maxDurationMs,
    ),
};
export const goodbyeInterviewInputBuilder: LabInterviewInputBuilder = {
  inputContract: "goodbye-interview-input/v1",
  closingLimit: true,
  build: (fields) =>
    createGoodbyeConversationInput(
      fields.instructions,
      fields.finishInterviewDescription,
      fields.closingSentence,
      fields.maxDurationMs,
      fields.maximumClosingDurationMs,
    ),
};
export const questionsInterviewInputBuilder: LabInterviewInputBuilder = {
  inputContract: "questions-interview-input/v1",
  closingLimit: true,
  build: (fields) =>
    createQuestionsConversationInput(
      fields.questionPrompts,
      fields.nextQuestionDescription,
      fields.finishInterviewDescription,
      fields.closingSentence,
      fields.maxDurationMs,
      fields.maximumClosingDurationMs,
    ),
};
const labInterviewInputBuilders: ReadonlyMap<string, LabInterviewInputBuilder> = new Map([
  ["original-interview", originalInterviewInputBuilder],
  ["goodbye-interview", goodbyeInterviewInputBuilder],
  ["questions-interview", questionsInterviewInputBuilder],
]);
/** The selected Conversation's builder, or `undefined` when Lab has none for it. */
export function findLabInterviewInputBuilder(
  selection: { conversation: { id: string } } | undefined,
): LabInterviewInputBuilder | undefined {
  return selection === undefined
    ? undefined
    : labInterviewInputBuilders.get(selection.conversation.id);
}
