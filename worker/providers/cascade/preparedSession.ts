import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { runtimeReasoningEffortValues } from "../../shared/contracts/runtimeStart.ts";
import type { ExecutionSettingsPreparation } from "../../runtime/nativeContracts.ts";
import {
  cascadeExecutionSettingsSchema,
  cascadeLanguageModelAccepts,
  cascadeProviderSettingsSchema,
  resolveCascadeProviderSettings,
} from "./settings.ts";

const cascadeSessionSettingsSchema = z.strictObject({
  /** The pair's registered provider combination, `cascade-v1/<conversation id>`. */
  combination: z.string().min(1),
  /** The model's reasoning effort; none when none, or `none`, was requested. */
  reasoning: z.strictObject({ effort: z.enum(runtimeReasoningEffortValues) }).nullable(),
  toolChoice: z.literal("auto"),
  maxOutputTokens: z.literal("inf"),
  /** What each provider uses: the start's Cascade settings, or today's values. */
  providers: cascadeProviderSettingsSchema,
});

/**
 * Cascade's prepared settings: only what its session uses. The model's requests send the tool
 * choice, the output cap and the reasoning effort; the combination names the pair's providers in
 * the settings summary; each provider uses its own settings.
 */
export type CascadeSessionSettings = z.output<typeof cascadeSessionSettingsSchema>;

/** A start request's execution settings arrive as JSON: inherited fields are not settings. */
const requestedSettingsSchema = z.preprocess(
  (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
  cascadeExecutionSettingsSchema,
);

/** The provider combination a Cascade pair of this Conversation registers. */
export function cascadeCombination(conversation: string): string {
  return `cascade-v1/${conversation}`;
}

/**
 * Prepares Cascade's settings from the Run's start choices: its reasoning effort and the start
 * request's execution settings, Cascade's own when given. Execution settings that are not
 * Cascade's, and a reasoning effort the chosen language model does not accept, such as `minimal`
 * on Cerebras, are refused before any provider work. A requested reasoning effort of `none`
 * sends no reasoning effort, as no effort requested does.
 */
export function prepareCascadeSettings(
  combination: string,
  choices: ExecutionSettingsPreparation,
): CascadeSessionSettings {
  const requested =
    choices.requested === undefined
      ? undefined
      : requestedSettingsSchema.safeParse(choices.requested);
  if (requested !== undefined && !requested.success) throw new Error("invalid_execution_settings");
  const effort = choices.reasoningEffort;
  const providers = resolveCascadeProviderSettings(requested?.data);
  if (effort !== null && !cascadeLanguageModelAccepts(providers, effort))
    throw new Error("invalid_execution_settings");
  return {
    combination,
    reasoning: effort === null || effort === "none" ? null : { effort },
    toolChoice: "auto",
    maxOutputTokens: "inf",
    providers,
  };
}

/**
 * Cascade's prepared settings as Runtime stored them: the kit's own persisted format, which its
 * session reads back when it starts.
 */
export const decodeCascadeSessionSettings = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    cascadeSessionSettingsSchema,
  ),
  convert: (settings): CascadeSessionSettings => settings,
});

/**
 * The summary Runtime keeps of Cascade's settings, which the Run's diagnostics show. Lab reads a
 * summary's `model` and `maxOutputTokens` as its run's model and token cap; for Cascade the model
 * is the combination. Each provider's settings follow, as the Run used them: a null Soniox
 * setting was not sent, so Soniox's default applied.
 */
export function summarizeCascadeSettings(settings: CascadeSessionSettings) {
  const summary = {
    model: settings.combination,
    maxOutputTokens: settings.maxOutputTokens,
    ...structuredClone(settings.providers),
  };
  return settings.reasoning === null
    ? summary
    : { ...summary, reasoningEffort: settings.reasoning.effort };
}
