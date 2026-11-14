import { z } from "zod";
import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";

/** Runtime's record of one provider function call and what Runtime did with it. */
export const runtimeToolCallRecordType = "runtime.tool_call_handled";

const identifier = z.string().min(1);

/**
 * The visit fields describe the visit when Runtime received the call; the record envelope's
 * attribution may already name the visit the call entered. For Questions, `context` carries
 * the Question index. Arguments are never stored, only their UTF-8 byte length.
 */
const callSchema = z.object({
  toolName: z.string(),
  toolCallId: identifier.nullable(),
  responseId: identifier.nullable(),
  argumentsBytes: z.number().int().safe().nonnegative().nullable(),
  state: identifier.nullable(),
  visitId: identifier.nullable(),
  operationId: identifier.nullable(),
  context: z.json().optional(),
});

export const runtimeToolCallPayloadSchema = z.discriminatedUnion("outcome", [
  // `to` is null only for a Run without a Conversation visit, whose finish ends the Run.
  callSchema.extend({ outcome: z.literal("transitioned"), to: identifier.nullable() }),
  callSchema.extend({
    outcome: z.literal("ignored"),
    reason: z.enum([
      // The Conversation evaluated the call and kept its state, such as
      // `next_question` on the last Question.
      "no_transition",
      // The current state does not accept this tool, or its report authority is no longer current.
      "not_accepted",
      // The call's response belongs to an earlier visit.
      "out_of_scope",
      // Runtime was not in Live, or did not interpret this receipt.
      "not_interpreted",
    ]),
  }),
  callSchema.extend({
    outcome: z.literal("rejected"),
    reason: z.enum(["unknown_tool", "undecodable"]),
  }),
]);
export type RuntimeToolCallPayload = z.output<typeof runtimeToolCallPayloadSchema>;
/** The payload as Runtime describes it, carrying the visit's own Conversation context value. */
export type RuntimeToolCallDescription = RuntimeToolCallPayload extends infer Payload
  ? Payload extends unknown
    ? Omit<Payload, "context"> & Readonly<{ context?: unknown }>
    : never
  : never;
/** What Runtime did with one call, decided where it interprets the call. */
export type RuntimeToolCallOutcome =
  | Readonly<{ outcome: "transitioned"; to: string | null }>
  | Readonly<{
      outcome: "ignored";
      reason: Extract<RuntimeToolCallPayload, { outcome: "ignored" }>["reason"];
    }>
  | Readonly<{
      outcome: "rejected";
      reason: Extract<RuntimeToolCallPayload, { outcome: "rejected" }>["reason"];
    }>;

/**
 * Decodes a stored record's `payloadJson`. The Run diagnostic context fields that Runtime
 * adds to every Runtime record are excluded from the owned value.
 */
export const decodeRuntimeToolCallPayload = boundary({
  schema: z.string().transform((text, context): RuntimeToolCallPayload => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      context.addIssue({ code: "custom", message: "tool_call_payload_not_json" });
      return z.NEVER;
    }
    const accepted = runtimeToolCallPayloadSchema.safeParse(parsed);
    if (accepted.success) return accepted.data;
    for (const issue of accepted.error.issues)
      context.addIssue({ code: "custom", message: issue.message, path: issue.path });
    return z.NEVER;
  }),
  convert: (payload: RuntimeToolCallPayload): RuntimeToolCallPayload => payload,
});
