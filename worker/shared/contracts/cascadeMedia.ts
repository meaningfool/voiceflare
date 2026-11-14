import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

/**
 * The Cascade browser media profile: Runtime's own media protocol between a Cascade
 * browser client and the Run's Cascade media session, carried by one WebSocket attachment.
 */
export const cascadeMediaConnectionProfile = "cascade-media-v1";

/** The interviewer audio every output of this profile carries: 16-bit PCM, 24 kHz, mono. */
export const cascadeMediaOutputFormat = Object.freeze({
  encoding: "pcm_s16le",
  sampleRate: 24_000,
  channels: 1,
} as const);

/** The participant audio the browser streams while listening: 16-bit PCM, 16 kHz, mono. */
export const cascadeMediaInputFormat = Object.freeze({
  encoding: "pcm_s16le",
  sampleRate: 16_000,
  channels: 1,
} as const);

const identity = z.string().min(1);
const outputFormatSchema = z.strictObject({
  encoding: z.literal(cascadeMediaOutputFormat.encoding),
  sampleRate: z.literal(cascadeMediaOutputFormat.sampleRate),
  channels: z.literal(cascadeMediaOutputFormat.channels),
});
const inputFormatSchema = z.strictObject({
  encoding: z.literal(cascadeMediaInputFormat.encoding),
  sampleRate: z.literal(cascadeMediaInputFormat.sampleRate),
  channels: z.literal(cascadeMediaInputFormat.channels),
});

/** The browser's Start connection input: the profile needs no native negotiation. */
export const cascadeMediaConnectionInputSchema = z.strictObject({});

/** Runtime's Start reply: the output format the browser plays and the input format it sends. */
export const cascadeMediaConnectionReplySchema = z.strictObject({
  output: outputFormatSchema,
  input: inputFormatSchema,
});
export type CascadeMediaConnectionReply = z.output<typeof cascadeMediaConnectionReplySchema>;

/**
 * Messages from the media session to the browser. Each interviewer output is identified,
 * its audio chunks are numbered in order, and it ends with exactly one of `output.ended`,
 * `output.cancelled` or `output.failed`. An output that ended can still be cancelled once, when
 * the conversation moved on while the browser may still be playing it: the browser stops it as
 * it stops any cancelled output. `input.listening` identifies one listening
 * opportunity: the browser streams its microphone for it once the output it names, if any,
 * has finished playing locally, and stops at `input.closed` for that opportunity.
 */
export const cascadeMediaServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("output.started"), outputId: identity }),
  z.strictObject({
    type: z.literal("output.audio"),
    outputId: identity,
    sequence: z.number().int().nonnegative(),
    audio: z.base64(),
  }),
  z.strictObject({
    type: z.literal("output.ended"),
    outputId: identity,
    chunkCount: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("output.cancelled"), outputId: identity }),
  z.strictObject({ type: z.literal("output.failed"), outputId: identity, code: identity }),
  z.strictObject({
    type: z.literal("input.listening"),
    opportunityId: identity,
    afterOutputId: identity.nullable(),
  }),
  z.strictObject({ type: z.literal("input.closed"), opportunityId: identity }),
]);
export type CascadeMediaServerMessage = z.output<typeof cascadeMediaServerMessageSchema>;

const serialized = z.preprocess((value) => {
  const parsed: unknown = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}, z.unknown());

/** The Cascade browser's decoder of one parsed media-session message. */
export const decodeCascadeMediaServerMessage = boundary({
  schema: serialized.pipe(cascadeMediaServerMessageSchema),
  convert: (value) => value,
});

/** The Cascade browser's decoder of an accepted Start: Runtime's reply for this profile. */
export const decodeCascadeMediaStartReply = boundary({
  schema: serialized.pipe(
    z.object({
      runId: identity,
      exchangeId: identity,
      acceptance: z.literal("accepted"),
      reply: cascadeMediaConnectionReplySchema,
    }),
  ),
  convert: (value) => value,
});

/**
 * The browser's message to the media session: microphone audio in the input format,
 * ordinary silence included, for the listening opportunity it names.
 */
export const cascadeMediaClientMessageSchema = z.strictObject({
  type: z.literal("input.audio"),
  opportunityId: identity,
  audio: z.base64(),
});
export type CascadeMediaClientMessage = z.output<typeof cascadeMediaClientMessageSchema>;

/** The media session's decoder of one WebSocket text message from the attached browser. */
export const decodeCascadeMediaClientMessage = boundary({
  schema: z.string().transform((text, context): CascadeMediaClientMessage => {
    let parsed;
    try {
      parsed = z.json().parse(JSON.parse(text));
    } catch {
      context.addIssue({ code: "custom", message: "The media message is not JSON" });
      return z.NEVER;
    }
    const message = cascadeMediaClientMessageSchema.safeParse(parsed);
    if (message.success) return message.data;
    for (const issue of message.error.issues)
      context.addIssue({ code: "custom", message: issue.message, path: issue.path });
    return z.NEVER;
  }),
  convert: (value) => value,
});
