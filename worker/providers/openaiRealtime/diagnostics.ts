import { z } from "zod";
import { gateTestOptionsDiagnostics } from "../../runtime/gateTestOptions.ts";

const statusDetails = z.object({ type: z.string().optional(), reason: z.string().optional() });
const item = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
});
const turnDetection = z.object({
  type: z.string().optional(),
  createResponse: z.boolean().optional(),
  interruptResponse: z.boolean().optional(),
  eagerness: z.string().optional(),
  threshold: z.number().finite().optional(),
});
const requestedSession = z.object({
  model: z.string(),
  voice: z.string(),
  maxOutputTokens: z.union([z.number().int().nonnegative(), z.literal("inf")]),
  reasoningEffort: z.string().optional(),
  inputNoiseReduction: z.object({ type: z.string() }),
  turnDetection: turnDetection.required({
    type: true,
    createResponse: true,
    interruptResponse: true,
  }),
});
const observedSession = z.object({
  model: z.string().optional(),
  voice: z.string().optional(),
  reasoningEffort: z.string().optional(),
  inputNoiseReduction: z.object({ type: z.string().optional() }).optional(),
  turnDetection: turnDetection.optional(),
});
const call = z.object({
  source: z.literal("realtime_execution"),
  phase: z.literal("setup"),
  provider: z.literal("openai_realtime"),
  sessionId: z.string(),
  upstreamRequestId: z.string().nullable(),
});
/** Pair-local provider interpretation and payload ownership. Extra raw fields are excluded. */
export const executionDiagnostics = Object.freeze({
  "realtime.call_identified": call,
  "realtime.call_recorded": call.extend({ settingsSummary: requestedSession }),
  "realtime.close_finished": z.object({
    source: z.literal("realtime_execution"),
    provider: z.literal("openai_realtime"),
    result: z.enum(["succeeded", "timed_out", "uncertain", "failed"]),
    status: z.number().int().optional(),
    code: z.string().optional(),
  }),
  "realtime.closure_confidence": z.object({
    source: z.literal("realtime_execution"),
    provider: z.literal("openai_realtime"),
    confidence: z.enum(["confirmed", "teardown_initiated_unconfirmed", "unconfirmed"]),
    basis: z.string(),
  }),
  "realtime.close_only_reconnect_suppressed": z.object({
    source: z.literal("realtime_execution"),
    provider: z.literal("openai_realtime"),
    observedAt: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
  }),
  /** Startup asked for the side connection; Runtime's `sessionConnected` stage records it open. */
  "realtime.side_connection_requested": z.object({
    source: z.literal("realtime_execution"),
    provider: z.literal("openai_realtime"),
    at: z.number().int().nonnegative(),
  }),
  /**
   * The conversing phase cut the speech of the reply that moved to the node it entered: it
   * cleared that reply's output, and OpenAI truncates the cut item to what was heard.
   */
  "realtime.reply_cut": z.object({
    source: z.literal("realtime_execution"),
    provider: z.literal("openai_realtime"),
    responseId: z.string(),
  }),
  /**
   * The Gate's supplied reply answered the opening phase's first participant turn in place of
   * the model's: a reply with the named tool call and no speech, which OpenAI never created.
   */
  "realtime.reply_supplied": z.object({
    source: z.literal("realtime_execution"),
    provider: z.literal("openai_realtime"),
    responseId: z.string(),
    toolName: z.string(),
  }),
  ...gateTestOptionsDiagnostics,
  "realtime.sideband_closed": z.object({
    source: z.literal("realtime_execution"),
    provider: z.literal("openai_realtime"),
    reason: z.string(),
    eventCount: z.number().int().nonnegative(),
    eventTypeCounts: z.record(z.string(), z.number().int().nonnegative()),
  }),
  "realtime.provider_event_observed": z.object({
    providerEventType: z.string(),
    source: z.literal("provider"),
    provider: z.literal("openai_realtime"),
    eventId: z.string().optional(),
    itemId: z.string().optional(),
    responseId: z.string().optional(),
    previousItemId: z.string().optional(),
    outputIndex: z.number().finite().optional(),
    contentIndex: z.number().finite().optional(),
    audioEndMs: z.number().finite().optional(),
    status: z.string().optional(),
    statusDetails: statusDetails.optional(),
    item: item.optional(),
    response: z
      .object({
        id: z.string().optional(),
        status: z.string().optional(),
        statusDetails: statusDetails.optional(),
        output: z.array(item).max(8).optional(),
        outputTokens: z.number().int().safe().nonnegative().optional(),
      })
      .optional(),
    session: observedSession.optional(),
    error: z
      .object({
        type: z.string().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
        param: z.string().optional(),
        eventId: z.string().optional(),
      })
      .optional(),
  }),
});
