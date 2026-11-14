export const defaultFinishInterviewDescription = `End the interview when the participant asks to stop, even if questions
remain, or after the final question and any needed follow-ups have
been answered.

IMPORTANT: Utter the closing message provided in the prompt verbatim (no addition or rephrasing), then call this
tool in the same response.

Do not ask another question or request confirmation.`;

export const testInterviewInstructions =
  "You are the Interview Agent. Conduct a short adaptive feedback interview. Ask one concise open follow-up at a time and avoid turning the conversation into a scripted survey.";

export function createInterviewConversationInput(
  instructions: string,
  finishDescription = defaultFinishInterviewDescription,
  interviewingDurationMs = 300_000,
) {
  return {
    contract: "original-interview-input/v1" as const,
    interviewingDurationMs,
    interviewing: {
      instructions: { kind: "literal" as const, text: instructions },
      toolDescriptions: { finish_interview: finishDescription },
    },
  };
}
