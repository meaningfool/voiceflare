import { z } from "zod";
import { gateTestOptionsDiagnostics } from "../../runtime/gateTestOptions.ts";

const output = z.object({
  source: z.literal("cascade_execution"),
  provider: z.literal("cascade"),
  outputId: z.string(),
});

const opportunity = z.object({
  source: z.literal("cascade_execution"),
  provider: z.literal("cascade"),
  opportunityId: z.string(),
});

const count = z.number().int().nonnegative();

/**
 * The Cascade kit's Runtime records of each interviewer output and listening opportunity.
 * Synthesis, server delivery and browser playback are distinct observations: these record the
 * first two only. The usage records are Cascade's account of its provider usage per output and
 * opportunity, which it also reports as usage entries for the published result.
 */
export const cascadeDiagnostics = Object.freeze({
  "cascade.media_attached": z.object({
    source: z.literal("cascade_execution"),
    provider: z.literal("cascade"),
  }),
  "cascade.media_detached": z.object({
    source: z.literal("cascade_execution"),
    provider: z.literal("cascade"),
    reason: z.string(),
  }),
  /**
   * An output opened to the browser, and what it says: the model's reply, a given sentence,
   * such as the closing's, which no model is asked for, or the Gate's supplied reply, a tool
   * call without speech that no model is asked for either.
   */
  "cascade.output_started": output.extend({ says: z.enum(["reply", "sentence", "supplied"]) }),
  ...gateTestOptionsDiagnostics,
  /** The speech-output provider finished synthesizing the output. */
  "cascade.output_synthesized": output.extend({ chunkCount: z.number().int().nonnegative() }),
  /** The media session delivered the output's explicit end after its last chunk. */
  "cascade.output_delivered": output.extend({ chunkCount: z.number().int().nonnegative() }),
  "cascade.output_cancelled": output.extend({ chunkCount: z.number().int().nonnegative() }),
  /**
   * A conversing phase entered during the conversation cut the output that moved to it: its
   * delivery stopped (`delivered: false`), or, its end already delivered, the browser was told
   * to stop playing it (`delivered: true`).
   */
  "cascade.output_cut": output.extend({ delivered: z.boolean() }),
  /**
   * The output failed with a provider or media failure. A provider's refusal also names its
   * reason, such as Cerebras's `queue_exceeded`, and the attempts made.
   */
  "cascade.output_failed": output.extend({
    code: z.string(),
    refusal: z.string().optional(),
    attempts: z.number().int().positive().optional(),
  }),
  /** A listening opportunity opened after the named output's delivery. */
  "cascade.listening_opened": opportunity.extend({ afterOutputId: z.string() }),
  /**
   * The opportunity closed: the chunks it forwarded to speech input, and the chunks the media
   * session has discarded so far because they named no open opportunity.
   */
  "cascade.listening_closed": opportunity.extend({
    acceptedChunks: z.number().int().nonnegative(),
    discardedChunks: z.number().int().nonnegative(),
  }),
  /** Speech input ended a turn without recognized text; no turn was admitted. */
  "cascade.turn_ignored": opportunity.extend({ reason: z.literal("empty") }),
  /** One participant turn was admitted; its text is in the transcript, not here. */
  "cascade.turn_admitted": opportunity.extend({
    itemId: z.string(),
    characters: z.number().int().positive(),
  }),
  /**
   * Input closed while the opportunity was open, and speech input settled what it had heard:
   * the final input's item and length, or no item when nothing was recognized.
   */
  "cascade.input_settled": opportunity.extend({
    itemId: z.string().nullable(),
    characters: count,
  }),
  /**
   * One output item the model completed in an output's response, in order: its type and, for a
   * message, the length of its text. Evidence of what the model produced, apart from the text
   * the session submitted for synthesis.
   */
  "cascade.model_output_item": output.extend({
    itemType: z.string(),
    characters: count.nullable(),
  }),
  /**
   * The model's provider refused one attempt of an output's response before any of it streamed,
   * and is asked again after the wait: the refusal, the attempt refused, counted from 1, and the
   * wait.
   */
  "cascade.model_retry": output.extend({
    refusal: z.string(),
    attempt: z.number().int().positive(),
    waitMs: count,
  }),
  /** The model's account of one output's response: the model that answered and its tokens. */
  "cascade.model_usage": output.extend({
    model: z.string(),
    inputTokens: count,
    outputTokens: count,
  }),
  /** The text one output gave speech synthesis, and the audio delivered for it. */
  "cascade.speech_output_usage": output.extend({ characters: count, audioMs: count }),
  /** The participant audio one opportunity forwarded to speech input. */
  "cascade.speech_input_usage": opportunity.extend({ audioMs: count }),
  /**
   * This Runtime instance does not hold the Run's recorded session, as after a restart: its
   * media and provider work are gone and nothing resumes them.
   */
  "cascade.session_lost": z.object({
    source: z.literal("cascade_execution"),
    provider: z.literal("cascade"),
    sessionId: z.string(),
  }),
  "cascade.input_failed": z.object({
    source: z.literal("cascade_execution"),
    provider: z.literal("cascade"),
    code: z.string(),
  }),
});
