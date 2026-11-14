import { Effect, Layer } from "effect";
import type { CascadeProviders } from "./adapters.ts";
import { missingCredentials, type ExecutionCredentials } from "../../runtime/nativeContracts.ts";
import { cerebrasChatCompletionsProvider } from "./cerebrasChatCompletions.ts";
import { gradiumSpeechInputProvider } from "./gradiumSpeechInput.ts";
import { gradiumSpeechOutputProvider } from "./gradiumSpeechOutput.ts";
import { openAiResponsesProvider } from "./openaiResponses.ts";
import type { CascadeAdapterOptions } from "./providerDeclaration.ts";
import {
  CascadeProviderSettings,
  cascadeDefaultProviderSettings,
  cascadeProviderDeclarations,
  chosenCascadeProviders,
  type CascadeProviderSettingsValue,
} from "./settings.ts";
import { sonioxSpeechInputProvider } from "./sonioxSpeechInput.ts";
import { sonioxSpeechOutputProvider } from "./sonioxSpeechOutput.ts";
import { cascadeUsageDeclarations } from "./usage.ts";

const unique = (names: readonly string[]): readonly string[] => [...new Set(names)];

/** The credentials of the providers a Run's settings choose, one per component. */
function credentialsOf(settings: CascadeProviderSettingsValue): readonly string[] {
  return unique(
    Object.values(chosenCascadeProviders(settings)).flatMap((chosen) => chosen.credentials),
  );
}

/**
 * The credentials today's providers need, which a Run without settings uses: Cascade's catalog
 * availability names these.
 */
export const cascadeProviderCredentials = credentialsOf(cascadeDefaultProviderSettings);

/** Every credential a registered Cascade provider declares: those Runtime reads for Cascade. */
export const cascadeDeclaredCredentials = unique(
  Object.values(cascadeProviderDeclarations).flatMap((declarations) =>
    declarations.flatMap((declaration) => declaration.credentials),
  ),
);

/**
 * The credentials a Cascade Run with these settings needs: today's providers', which its
 * combination's availability requires, and those of each provider its settings choose.
 */
export function cascadeRunCredentials(settings: CascadeProviderSettingsValue): readonly string[] {
  return unique([...cascadeProviderCredentials, ...credentialsOf(settings)]);
}

/**
 * What Cascade reports on its providers: the union of every registered provider's entries, so
 * Runtime admits the usage of whichever provider a Run chose. The controlled stand-ins report in
 * the vocabulary of today's providers.
 */
export const cascadeProviderUsage = cascadeUsageDeclarations({
  speechInput: cascadeProviderDeclarations.speechInput.map(({ usage }) => usage.provider),
  languageModel: cascadeProviderDeclarations.languageModel.map(({ usage }) => usage.provider),
  speechOutput: cascadeProviderDeclarations.speechOutput.map(({ usage }) => usage.provider),
});

/**
 * Cascade's real providers, built when the session's providers start: one adapter per
 * component, of the provider the Run's settings chose, with its own credential from Runtime's
 * set. Start refuses a Run whose chosen providers lack a credential. Without today's providers'
 * credentials there are none, as Cascade's catalog availability reports, and a Cascade session
 * start fails with `cascade_providers_unavailable`.
 */
export function cascadeProviderAdapters(
  credentials: ExecutionCredentials,
  // The platform's fetch must be called as a plain function, never as a method of the options.
  transport: typeof fetch = (input, init) => fetch(input, init),
): CascadeProviders | undefined {
  if (missingCredentials(cascadeProviderCredentials, credentials).length > 0) return undefined;
  const options = ({ credentials: [name] }: Readonly<{ credentials: readonly [string] }>) =>
    ({ apiKey: credentials[name] ?? "", transport }) satisfies CascadeAdapterOptions;
  // Each component's adapter is its chosen provider's, built with that provider's settings.
  const speechInput = (settings: CascadeProviderSettingsValue["speechInput"]) => {
    switch (settings.provider) {
      case "soniox":
        return sonioxSpeechInputProvider.adapter(options(sonioxSpeechInputProvider), settings);
      case "gradium":
        return gradiumSpeechInputProvider.adapter(options(gradiumSpeechInputProvider), settings);
    }
  };
  const languageModel = (settings: CascadeProviderSettingsValue["languageModel"]) => {
    switch (settings.provider) {
      case "openai":
        return openAiResponsesProvider.adapter(options(openAiResponsesProvider), settings);
      case "cerebras":
        return cerebrasChatCompletionsProvider.adapter(
          options(cerebrasChatCompletionsProvider),
          settings,
        );
    }
  };
  const speechOutput = (settings: CascadeProviderSettingsValue["speechOutput"]) => {
    switch (settings.provider) {
      case "soniox":
        return sonioxSpeechOutputProvider.adapter(options(sonioxSpeechOutputProvider), settings);
      case "gradium":
        return gradiumSpeechOutputProvider.adapter(options(gradiumSpeechOutputProvider), settings);
    }
  };
  return Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* CascadeProviderSettings;
      return Layer.mergeAll(
        speechInput(settings.speechInput),
        languageModel(settings.languageModel),
        speechOutput(settings.speechOutput),
      );
    }),
  );
}
