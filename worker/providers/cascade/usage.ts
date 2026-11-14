import type { ConversationUsageEvidence } from "../../runtime/runtimeUsage.ts";
import type {
  RuntimeUsageObservation,
  UsageDeclaration,
} from "../../shared/contracts/runtimeTerminalResult.ts";

/**
 * The provider and model a Cascade speech provider's usage entries name. The language model
 * names only its provider: each response's account names the model that answered.
 */
export type CascadeUsageSource = Readonly<{ provider: string; model: string }>;

/** What each Cascade component reports of one provider's work, in its unit. */
const componentMeasures = Object.freeze({
  /** The participant audio one listening opportunity forwarded to speech input. */
  speech_to_text: [{ measure: "input_audio", unit: "audio_millisecond" }],
  /** The model's account of one response: its input and output tokens. */
  language_model: [
    { measure: "input_text", unit: "token" },
    { measure: "output_text", unit: "token" },
  ],
  /** The text one output gave speech synthesis, and the audio delivered for it. */
  text_to_speech: [
    { measure: "input_text", unit: "character" },
    { measure: "output_audio", unit: "audio_millisecond" },
  ],
} as const);
type CascadeComponent = keyof typeof componentMeasures;
type ComponentMeasure<Component extends CascadeComponent> =
  (typeof componentMeasures)[Component][number]["measure"];

/** What a Cascade session may report, with each provider each of its components may run on. */
export function cascadeUsageDeclarations(
  providers: Readonly<{
    speechInput: readonly string[];
    languageModel: readonly string[];
    speechOutput: readonly string[];
  }>,
): readonly UsageDeclaration[] {
  const declare = (component: CascadeComponent, names: readonly string[]) =>
    [...new Set(names)].flatMap((provider) =>
      componentMeasures[component].map(({ measure, unit }) => ({
        componentRole: component,
        provider,
        measure,
        unit,
      })),
    );
  return Object.freeze([
    ...declare("speech_to_text", providers.speechInput),
    ...declare("language_model", providers.languageModel),
    ...declare("text_to_speech", providers.speechOutput),
  ]);
}

/** The usage of one operation of a component, under its key, expected before it starts. */
export function expectedUsage(component: CascadeComponent, key: string): ConversationUsageEvidence {
  return { status: "expected", componentRole: component, key: `${component}:${key}` };
}

/**
 * One operation's settled usage: its entries, leaving out measures it did not use, or unknown
 * usage when its provider gave no account.
 */
export function settledUsage<Component extends CascadeComponent>(
  component: Component,
  key: string,
  account: Readonly<{
    provider: string;
    model: string;
    quantities: Readonly<Record<ComponentMeasure<Component>, number>>;
  }> | null,
): ConversationUsageEvidence {
  const identity = { componentRole: component, key: `${component}:${key}` };
  if (account === null) return { ...identity, status: "unavailable" };
  const quantities: Readonly<Record<string, number | undefined>> = account.quantities;
  const measurements = componentMeasures[component].flatMap(
    ({ measure, unit }): RuntimeUsageObservation[] => {
      const quantity = quantities[measure] ?? 0;
      return quantity > 0
        ? [
            {
              componentRole: component,
              provider: account.provider,
              model: account.model,
              measure,
              unit,
              quantity,
            },
          ]
        : [];
    },
  );
  return { ...identity, status: "satisfied", measurements };
}
