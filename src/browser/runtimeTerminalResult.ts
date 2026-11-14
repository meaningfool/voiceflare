import { z } from "zod";
import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";

/**
 * The units a usage entry may count in: a closed list, so a new unit is a deliberate change of
 * the format. Components, providers, models and measures are free text: each provider declares
 * the ones it reports, and Runtime publishes only entries the Run's combination declares.
 */
export const runtimeUsageUnits = ["token", "character", "audio_millisecond"] as const;
export type RuntimeUsageUnit = (typeof runtimeUsageUnits)[number];
const usageName = z.string().trim().min(1);
export const runtimeUsageObservationSchema = z.strictObject({
  componentRole: usageName,
  provider: usageName,
  model: usageName,
  measure: usageName,
  unit: z.enum(runtimeUsageUnits),
  quantity: z.number().int().safe().positive(),
});
export type RuntimeUsageObservation = Readonly<z.output<typeof runtimeUsageObservationSchema>>;
/**
 * One kind of usage entry a provider reports, which a combination publishes: its component,
 * provider, measure and unit. The model is not declared: each entry names the model that served
 * it.
 */
export const usageDeclarationSchema = runtimeUsageObservationSchema.omit({
  model: true,
  quantity: true,
});
export type UsageDeclaration = Readonly<z.output<typeof usageDeclarationSchema>>;
export const runtimeUsageObservationsSchema = z
  .array(runtimeUsageObservationSchema)
  .readonly()
  .superRefine((observations, context) => {
    const keys = observations.map((item) =>
      [item.componentRole, item.provider, item.model, item.measure, item.unit].join(":"),
    );
    if (
      keys.some((key, index) => {
        const previousKey = keys[index - 1];
        return previousKey !== undefined && key <= previousKey;
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime usage observations must be unique and deterministically ordered.",
      });
    }
  });
export const runtimeUsageAggregateSchema = z.strictObject({
  completeness: z.enum(["complete", "incomplete"]),
  observations: runtimeUsageObservationsSchema,
});
export type RuntimeUsageAggregate = Readonly<z.output<typeof runtimeUsageAggregateSchema>>;

export const completeEmptyRuntimeUsage: RuntimeUsageAggregate = {
  completeness: "complete",
  observations: [],
};

export const failedToStartResultSchema = z.strictObject({
  runId: z.string().trim().min(1),
  outcome: z.literal("failed_to_start"),
  endedAt: z.number().int().nonnegative().refine(Number.isSafeInteger),
  runtimeUsage: runtimeUsageAggregateSchema,
});
export type FailedToStartResult = Readonly<z.output<typeof failedToStartResultSchema>>;
const failedToStartResultBoundary = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    failedToStartResultSchema,
  ),
  convert: (result) => result,
});

interface FailedToStartParser {
  (value: unknown): FailedToStartResult | null;
}
export const parseFailedToStartResult: FailedToStartParser = (value) => {
  try {
    return failedToStartResultBoundary(value);
  } catch {
    return null;
  }
};

const runtimeStartFailureSchema = z.strictObject({
  error: z.string().min(1),
  acceptance: z.enum(["accepted", "not_accepted"]),
});
export type RuntimeStartFailure = Readonly<z.output<typeof runtimeStartFailureSchema>>;
const runtimeStartFailureBoundary = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    runtimeStartFailureSchema,
  ),
  convert: (failure) => failure,
});

interface RuntimeStartFailureParser {
  (value: unknown): RuntimeStartFailure | null;
}
export const parseRuntimeStartFailure: RuntimeStartFailureParser = (value) => {
  try {
    return runtimeStartFailureBoundary(value);
  } catch {
    return null;
  }
};

const terminalTimeSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const transcriptIncompleteReasonSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("eligible_transcript_item_pending"),
    itemId: z.string().trim().min(1),
    role: z.enum(["participant", "conversationAgent"]),
  }),
  z.strictObject({
    kind: z.literal("eligible_transcript_item_failed"),
    itemId: z.string().trim().min(1),
    role: z.enum(["participant", "conversationAgent"]),
  }),
  z.strictObject({ kind: z.literal("final_input_unresolved") }),
  z.strictObject({ kind: z.literal("conversation_evidence_gap") }),
  z.strictObject({
    kind: z.literal("closing_response_inventory_unresolved"),
    responseId: z.string().trim().min(1),
  }),
]);
export type TranscriptIncompleteReason = Readonly<
  z.output<typeof transcriptIncompleteReasonSchema>
>;
const liveTerminalResultBaseFields = {
  runId: z.string().trim().min(1),
  liveAt: terminalTimeSchema,
  endedAt: terminalTimeSchema,
  transcriptSnapshot: z.strictObject({
    revision: terminalTimeSchema,
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    turnCount: terminalTimeSchema,
  }),
  transcriptCompleteness: z.enum(["complete", "incomplete"]),
  runtimeUsage: runtimeUsageAggregateSchema,
};
const currentLiveTerminalResultFields = {
  ...liveTerminalResultBaseFields,
  transcriptIncompleteReasons: z.array(transcriptIncompleteReasonSchema).readonly(),
};
const storedLiveTerminalResultFields = {
  ...liveTerminalResultBaseFields,
  // Compatibility is confined to application records written before the current callback contract.
  transcriptIncompleteReasons: z.array(transcriptIncompleteReasonSchema).readonly().optional(),
};
function validateTranscriptCompleteness(
  result: Readonly<{
    transcriptCompleteness: "complete" | "incomplete";
    transcriptIncompleteReasons?: readonly TranscriptIncompleteReason[] | undefined;
  }>,
  context: z.RefinementCtx,
): void {
  const reasons = result.transcriptIncompleteReasons;
  if (reasons === undefined) return;
  if (result.transcriptCompleteness === "complete" && reasons.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["transcriptIncompleteReasons"],
      message: "A complete Transcript cannot carry incomplete reasons.",
    });
  }
  if (result.transcriptCompleteness === "incomplete" && reasons.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["transcriptIncompleteReasons"],
      message: "An incomplete Transcript must carry at least one reason.",
    });
  }
}
export const interruptedResultSchema = z
  .strictObject({
    ...currentLiveTerminalResultFields,
    outcome: z.literal("interrupted"),
  })
  .superRefine(validateTranscriptCompleteness)
  .refine((result) => result.endedAt >= result.liveAt);
export type InterruptedResult = Readonly<z.output<typeof interruptedResultSchema>>;
export const completedResultSchema = z
  .strictObject({
    ...currentLiveTerminalResultFields,
    outcome: z.literal("completed"),
    reason: z.enum(["participant_stopped", "timebox_reached", "agent_requested_end"]),
  })
  .superRefine(validateTranscriptCompleteness)
  .refine((result) => result.endedAt >= result.liveAt);
export type CompletedResult = Readonly<z.output<typeof completedResultSchema>>;
export const liveTerminalResultSchema = z.union([interruptedResultSchema, completedResultSchema]);
export type LiveTerminalResult = InterruptedResult | CompletedResult;
export const runtimeTerminalResultSchema = z.union([
  failedToStartResultSchema,
  interruptedResultSchema,
  completedResultSchema,
]);
export type RuntimeTerminalResult = Readonly<z.output<typeof runtimeTerminalResultSchema>>;
const runtimeTerminalResultBoundary = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    runtimeTerminalResultSchema,
  ),
  convert: (result) => result,
});
interface RuntimeTerminalResultParser {
  (value: unknown): RuntimeTerminalResult | null;
}
export const parseRuntimeTerminalResult: RuntimeTerminalResultParser = (value) => {
  try {
    return runtimeTerminalResultBoundary(value);
  } catch {
    return null;
  }
};

const storedInterruptedResultSchema = z
  .strictObject({
    ...storedLiveTerminalResultFields,
    outcome: z.literal("interrupted"),
  })
  .superRefine(validateTranscriptCompleteness)
  .refine((result) => result.endedAt >= result.liveAt);
const storedCompletedResultSchema = z
  .strictObject({
    ...storedLiveTerminalResultFields,
    outcome: z.literal("completed"),
    reason: z.enum(["participant_stopped", "timebox_reached", "agent_requested_end"]),
  })
  .superRefine(validateTranscriptCompleteness)
  .refine((result) => result.endedAt >= result.liveAt);
const storedRuntimeTerminalResultSchema = z.union([
  failedToStartResultSchema,
  storedInterruptedResultSchema,
  storedCompletedResultSchema,
]);
export type StoredRuntimeTerminalResult = Readonly<
  z.output<typeof storedRuntimeTerminalResultSchema>
>;
interface StoredRuntimeTerminalResultParser {
  (value: unknown): StoredRuntimeTerminalResult | null;
}
export const parseStoredRuntimeTerminalResult: StoredRuntimeTerminalResultParser = (value) => {
  try {
    const ownedJson = z.json().parse(JSON.parse(JSON.stringify(value)));
    const result = storedRuntimeTerminalResultSchema.safeParse(ownedJson);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};
interface InterruptedResultParser {
  (value: unknown): InterruptedResult | null;
}
export const parseInterruptedResult: InterruptedResultParser = (value) => {
  const result = parseRuntimeTerminalResult(value);
  return result?.outcome === "interrupted" ? result : null;
};

interface LiveTerminalResultParser {
  (value: unknown): LiveTerminalResult | null;
}
export const parseLiveTerminalResult: LiveTerminalResultParser = (value) => {
  const result = parseRuntimeTerminalResult(value);
  return result?.outcome === "interrupted" || result?.outcome === "completed" ? result : null;
};
interface CompletedResultParser {
  (value: unknown): CompletedResult | null;
}
export const parseCompletedResult: CompletedResultParser = (value) => {
  const result = parseRuntimeTerminalResult(value);
  return result?.outcome === "completed" ? result : null;
};
