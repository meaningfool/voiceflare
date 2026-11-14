import type { LanguageModelRequest } from "./providers/cascade/adapters.ts";
import type { StandInResponse } from "./providers/cascade/testing/standIns.ts";

/** The stand-in opening: a few seconds of speech whose synthesis runs ahead of playback. */
export const standInOpening: StandInResponse = Object.freeze({
  text: Object.freeze([
    "Welcome. ",
    "This is the controlled Cascade opening, ",
    "streamed by the stand-in speech output ",
    "while its audio is still arriving in the browser.",
  ]),
});

/** The stand-in's next question, after any participant turn. */
export const standInNextQuestion: StandInResponse = Object.freeze({
  text: Object.freeze([
    "Thank you. ",
    "This is the controlled Cascade's next question, ",
    "streamed once your answer ended.",
  ]),
});

/** The stand-in closing, spoken in the same response as its `finish_interview` call. */
export const standInClosing: StandInResponse = Object.freeze({
  text: Object.freeze(["Thank you. ", "Goodbye."]),
  toolCalls: Object.freeze([Object.freeze({ name: "finish_interview", arguments: "{}" })]),
});

/** A `finish_interview` call without speech, which leaves the closing to its own phase. */
const standInFinish: StandInResponse = Object.freeze({
  text: Object.freeze([]),
  toolCalls: Object.freeze([Object.freeze({ name: "finish_interview", arguments: "{}" })]),
});

/**
 * The interview script the local Runtime gives the Cascade stand-ins' model, which the voice
 * suite's Cascade scenarios rely on. It reads the shape of the interview prompts, the
 * Lab presets and Runtime's sample interviews, so it lives outside the Cascade kit, whose
 * stand-ins know no interview.
 *
 * The opening first; after a participant turn, the closing with `finish_interview` once the
 * participant asked to end the interview or answered as many questions as a literal prompt
 * numbers (lines that start with "1. ", "2. ", ...); otherwise the next numbered question as
 * the prompt writes it, streamed phrase by phrase, or `standInNextQuestion` for a prompt
 * without numbered questions, which never finishes. A prompt that keeps its closing for the
 * dedicated closing response, as the Goodbye preset does, finishes without speech: Goodbye's
 * closing says its sentence with no model request. A Questions prompt, which names its question as "Current question: N of M", follows
 * `standInQuestionResponse`. This is controlled-provider output: the prompt is read, never sent
 * anywhere.
 */
export function standInInterviewResponse(request: LanguageModelRequest): StandInResponse {
  const answers = request.history.filter((turn) => turn.role === "participant");
  const last = answers.at(-1);
  const prompt = request.instructions.kind === "literal" ? request.instructions.text : "";
  const question = standInQuestion(prompt);
  if (question !== null) return standInQuestionResponse(question, request.history);
  if (last === undefined) return standInOpening;
  const questions = prompt
    .split("\n")
    .flatMap((line) => (/^\d+\. /.test(line) ? [line.replace(/^\d+\. /, "")] : []));
  const stopRequested = /end the interview/i.test(last.text);
  if (stopRequested || (questions.length > 0 && answers.length >= questions.length))
    return /dedicated closing response/i.test(prompt) ? standInFinish : standInClosing;
  const next = questions[answers.length];
  return next === undefined
    ? standInNextQuestion
    : { text: next.match(/[^,.?]+[,.?]?\s*/g) ?? [next] };
}

/** A Questions prompt's question: its position, the question count and its text. */
type StandInQuestion = Readonly<{ position: number; count: number; text: string }>;

/**
 * The question a Questions prompt asks: the line after "Current question: N of M", as the Lab
 * Questions preset writes it; null for any other prompt.
 */
function standInQuestion(prompt: string): StandInQuestion | null {
  const lines = prompt.split("\n");
  const index = lines.findIndex((line) => /^Current question: \d+ of \d+$/.test(line));
  const header = /^Current question: (\d+) of (\d+)$/.exec(lines[index] ?? "");
  const text = lines[index + 1]?.trim() ?? "";
  if (header === null || text.length === 0) return null;
  return { position: Number(header[1]), count: Number(header[2]), text };
}

/**
 * A Question's script: until the question was asked and answered, the question as the prompt
 * writes it, streamed phrase by phrase, after "Welcome. " on the first question. The history
 * holds earlier questions' turns, so the answer is a participant turn after the interviewer turn
 * that asked this question. After it, a tool call without speech, as the preset asks:
 * `finish_interview` on the last question or when the participant asked to end the interview,
 * otherwise `next_question`.
 */
function standInQuestionResponse(
  question: StandInQuestion,
  history: LanguageModelRequest["history"],
): StandInResponse {
  let asked = -1;
  history.forEach((turn, index) => {
    if (turn.role === "interviewer" && turn.text.includes(question.text)) asked = index;
  });
  const answer =
    asked < 0
      ? undefined
      : history
          .slice(asked + 1)
          .filter((turn) => turn.role === "participant")
          .at(-1);
  if (answer === undefined)
    return {
      text: [
        ...(question.position === 1 ? ["Welcome. "] : []),
        ...(question.text.match(/[^,.?]+[,.?]?\s*/g) ?? [question.text]),
      ],
    };
  if (/end the interview/i.test(answer.text) || question.position >= question.count)
    return standInFinish;
  return { text: [], toolCalls: [{ name: "next_question", arguments: "{}" }] };
}
