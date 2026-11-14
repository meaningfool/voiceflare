import { z } from "zod";

/**
 * The voice Gate's test options (#1059), which only a local build selects
 * (`runtimeLocalConfiguration.ts`): a deployed Runtime has neither, and no interview input or
 * Start request names them.
 *
 * - `noTools`: the model receives no tools and no tool choice, on every execution; its
 *   instructions are unchanged.
 * - `suppliedNextQuestion`: in a Questions interview, the reply to question 1's answer is
 *   `next_question`, without speech. Runtime applies it in place of the model's reply.
 */
export type GateTestOptions = Readonly<{ noTools: boolean; suppliedNextQuestion: boolean }>;

/**
 * The Gate options as one pair's session applies them: whether it withholds tools, and the tool
 * call, if any, that answers its opening phase's first participant turn in place of the model's
 * reply, without speech.
 */
export type GateSessionOptions = Readonly<{
  noTools: boolean;
  suppliedReply: Readonly<{ toolName: string }> | null;
}>;

/**
 * The record a session keeps of the Gate options it applies, once, as its Run starts: the
 * evidence a Gate run checks before it plays an answer. A Run without it applied none.
 */
export const gateTestOptionsDiagnostics = Object.freeze({
  "gate.test_options": z.object({
    noTools: z.boolean(),
    /** The supplied reply's tool name, or null when the session supplies none. */
    suppliedReply: z.string().nullable(),
  }),
});

/** The record's payload for a session's options. */
export function gateTestOptionsRecord(options: GateSessionOptions) {
  return { noTools: options.noTools, suppliedReply: options.suppliedReply?.toolName ?? null };
}
