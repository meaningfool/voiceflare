import { Context } from "effect";
import { z } from "zod";
import type { ReasoningEffort } from "../../runtime/nativeContracts.ts";
import {
  cerebrasChatCompletionsGivenSettings,
  cerebrasChatCompletionsProvider,
  cerebrasChatCompletionsSettings,
} from "./cerebrasChatCompletions.ts";
import {
  gradiumSpeechInputGivenSettings,
  gradiumSpeechInputProvider,
  gradiumSpeechInputSettings,
} from "./gradiumSpeechInput.ts";
import {
  gradiumSpeechOutputGivenSettings,
  gradiumSpeechOutputProvider,
  gradiumSpeechOutputSettings,
} from "./gradiumSpeechOutput.ts";
import {
  openAiResponsesGivenSettings,
  openAiResponsesProvider,
  openAiResponsesSettings,
} from "./openaiResponses.ts";
import {
  sonioxSpeechInputGivenSettings,
  sonioxSpeechInputProvider,
  sonioxSpeechInputSettings,
} from "./sonioxSpeechInput.ts";
import {
  sonioxSpeechOutputGivenSettings,
  sonioxSpeechOutputProvider,
  sonioxSpeechOutputSettings,
} from "./sonioxSpeechOutput.ts";

/**
 * The settings Cascade accepts at Start: one group per component, each naming its provider in
 * `provider`, with that provider's own settings beside it, as each provider declares them next
 * to its adapter. Languages, endpoint detection and the audio formats stay fixed: the media
 * profile owns the formats.
 */

/**
 * Each component's registered providers, each declared in its own module. The first is today's
 * provider, which a group left out, or given without `provider`, uses: Soniox, Cerebras and
 * Soniox (#1131).
 */
export const cascadeProviderDeclarations = Object.freeze({
  speechInput: Object.freeze([sonioxSpeechInputProvider, gradiumSpeechInputProvider] as const),
  languageModel: Object.freeze([cerebrasChatCompletionsProvider, openAiResponsesProvider] as const),
  speechOutput: Object.freeze([sonioxSpeechOutputProvider, gradiumSpeechOutputProvider] as const),
});

/**
 * One group's settings, one variant per provider, told apart by `provider`: a field that is not
 * the chosen provider's is refused. A group that names no provider is `unnamed`'s.
 */
function providerGroup<const Options extends readonly [z.ZodObject, ...z.ZodObject[]]>(
  unnamed: string,
  options: Options,
) {
  return z.preprocess(
    (group) =>
      typeof group === "object" && group !== null && !Array.isArray(group) && !("provider" in group)
        ? { ...group, provider: unnamed }
        : group,
    z.discriminatedUnion("provider", options),
  );
}

const { speechInput, languageModel, speechOutput } = cascadeProviderDeclarations;

/**
 * The providers #1020 stored a Run's groups for, before groups named their provider: Soniox,
 * OpenAI Responses and Soniox. A stored group without `provider` is theirs, whichever provider
 * is today's.
 */
const storedUnnamed = Object.freeze({
  speechInput: sonioxSpeechInputProvider.provider,
  languageModel: openAiResponsesProvider.provider,
  speechOutput: sonioxSpeechOutputProvider.provider,
});

/**
 * Cascade's execution settings, which a start request carries as opaque data. Every group and
 * every setting beside `provider` may be left out; an unknown provider, a value outside its list
 * or range, or any other field, is refused before provider work.
 */
export const cascadeExecutionSettingsSchema = z.strictObject({
  languageModel: providerGroup(languageModel[0].provider, [
    cerebrasChatCompletionsGivenSettings,
    openAiResponsesGivenSettings,
  ]).optional(),
  speechInput: providerGroup(speechInput[0].provider, [
    sonioxSpeechInputGivenSettings,
    gradiumSpeechInputGivenSettings,
  ]).optional(),
  speechOutput: providerGroup(speechOutput[0].provider, [
    sonioxSpeechOutputGivenSettings,
    gradiumSpeechOutputGivenSettings,
  ]).optional(),
});

export type CascadeExecutionSettings = z.output<typeof cascadeExecutionSettingsSchema>;

/**
 * The settings a Cascade session's providers use: each component's provider and every one of
 * its settings decided. Runtime stores them with the Run; a group stored before groups named
 * their provider (#1020) reads as the provider #1020 stored it for.
 */
export const cascadeProviderSettingsSchema = z.strictObject({
  languageModel: providerGroup(storedUnnamed.languageModel, [
    cerebrasChatCompletionsSettings,
    openAiResponsesSettings,
  ]),
  speechInput: providerGroup(storedUnnamed.speechInput, [
    sonioxSpeechInputSettings,
    gradiumSpeechInputSettings,
  ]),
  speechOutput: providerGroup(storedUnnamed.speechOutput, [
    sonioxSpeechOutputSettings,
    gradiumSpeechOutputSettings,
  ]),
});

export type CascadeProviderSettingsValue = z.output<typeof cascadeProviderSettingsSchema>;

/** The declaration of the provider a group names; a decoded group names a registered one. */
function declarationOf<Declaration extends Readonly<{ provider: string }>>(
  declarations: readonly Declaration[],
  provider: string,
): Declaration {
  const declaration = declarations.find((candidate) => candidate.provider === provider);
  if (declaration === undefined) throw new Error(`cascade_provider_unregistered:${provider}`);
  return declaration;
}

/**
 * Decides every provider setting: each group's provider, today's when the start names none,
 * then each setting the start gave and that provider's default for every other.
 */
export function resolveCascadeProviderSettings(
  given: CascadeExecutionSettings | undefined,
): CascadeProviderSettingsValue {
  const decide = (
    declarations: readonly [
      Readonly<{ provider: string; defaults: object }>,
      ...Readonly<{ provider: string; defaults: object }>[],
    ],
    group: Readonly<{ provider: string }> | undefined,
  ) => ({
    ...declarationOf(declarations, group?.provider ?? declarations[0].provider).defaults,
    ...group,
  });
  return cascadeProviderSettingsSchema.parse({
    languageModel: decide(languageModel, given?.languageModel),
    speechInput: decide(speechInput, given?.speechInput),
    speechOutput: decide(speechOutput, given?.speechOutput),
  });
}

/** Today's providers and values: what a Cascade Run uses when its start gives no settings. */
export const cascadeDefaultProviderSettings: CascadeProviderSettingsValue = Object.freeze(
  resolveCascadeProviderSettings(undefined),
);

/** Each component's provider declaration, as a Run's settings choose them. */
export function chosenCascadeProviders(settings: CascadeProviderSettingsValue) {
  return {
    speechInput: declarationOf(speechInput, settings.speechInput.provider),
    languageModel: declarationOf(languageModel, settings.languageModel.provider),
    speechOutput: declarationOf(speechOutput, settings.speechOutput.provider),
  };
}

/**
 * Whether the language model a Run's settings choose accepts this reasoning effort: every effort,
 * unless its provider names those it accepts.
 */
export function cascadeLanguageModelAccepts(
  settings: CascadeProviderSettingsValue,
  effort: ReasoningEffort,
): boolean {
  const chosen: Readonly<{ provider: string; reasoningEfforts?: readonly ReasoningEffort[] }> =
    chosenCascadeProviders(settings).languageModel;
  return chosen.reasoningEfforts?.includes(effort) ?? true;
}

/**
 * The settings of the session's providers, from which its provider assembly builds one adapter
 * per component. The controlled stand-ins read none.
 */
export class CascadeProviderSettings extends Context.Service<
  CascadeProviderSettings,
  CascadeProviderSettingsValue
>()("providers/cascade/CascadeProviderSettings") {}
