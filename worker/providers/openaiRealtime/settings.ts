import { z } from "zod";
export const runtimeReasoningEffortValues = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const);

/**
 * Realtime's execution settings, which a start request carries as opaque data: Lab's Realtime
 * settings. Realtime refuses any other value before provider work.
 */
export const realtimeExecutionSettingsSchema = z.strictObject({
  model: z.enum(["gpt-realtime-2", "gpt-realtime-2.1"]),
  voice: z.enum([
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
    "marin",
    "cedar",
  ]),
  speed: z.number().min(0.25).max(1.5),
  inputNoiseReduction: z.enum(["off", "near_field", "far_field"]),
  semanticVadEagerness: z.enum(["low", "medium", "high"]),
  maxOutputTokens: z.union([z.number().int().min(1).max(4096), z.literal("inf")]),
  truncation: z.enum(["auto", "disabled"]),
});

export type RealtimeExecutionSettings = z.output<typeof realtimeExecutionSettingsSchema>;

interface ReasoningEffortGuard {
  (
    value: unknown,
  ): value is import("../../shared/contracts/runtimeStart.ts").RuntimeReasoningEffort;
}
export const isReasoningEffort: ReasoningEffortGuard = (
  value,
): value is import("../../shared/contracts/runtimeStart.ts").RuntimeReasoningEffort =>
  z.enum(runtimeReasoningEffortValues).safeParse(value).success;
