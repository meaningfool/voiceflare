import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { z } from "zod";
import { parseRealtimeEvent } from "./providerEvents.ts";

const receiptSchema = z.object({
  type: z.string(),
  event_id: z.string().optional(),
  response_id: z.string().optional(),
  response: z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
      output: z
        .array(
          z.object({
            type: z.string().optional(),
            content: z.array(z.object({ type: z.string() })).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  session: z
    .object({
      instructions: z.string().optional(),
      audio: z
        .object({
          input: z.object({
            turn_detection: z
              .union([
                z.null(),
                z.object({
                  type: z.string().optional(),
                  eagerness: z.string().optional(),
                  threshold: z.number().optional(),
                  create_response: z.boolean().optional(),
                  interrupt_response: z.boolean().optional(),
                }),
              ])
              .optional(),
          }),
        })
        .optional(),
    })
    .optional(),
  error: z
    .object({ event_id: z.string().optional(), code: z.string().nullable().optional() })
    .optional(),
});
/**
 * A side-connection receipt as the kit's node operations read it: the closing and a pair's own
 * node entries settle their commands and replies on these fields.
 */
export type RealtimeReceipt = z.output<typeof receiptSchema>;
// The native provider independently evolves; this bounded adapter accepts only the
// receipt fields the node operations read and excludes unknown data from its owner.
export const decodeRealtimeReceipt = boundary.tolerant({
  source: "provider Realtime receipt",
  variants: [
    { schema: z.preprocess(parseRealtimeEvent, receiptSchema), convert: (event) => event },
  ],
  otherwise: failure("invalid_realtime_provider_receipt"),
});
