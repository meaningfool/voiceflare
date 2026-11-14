import { z } from "zod";
import {
  cascadeExecutionSettingsSchema,
  cascadeProviderDeclarations,
} from "../../providers/cascade/settings.ts";
import { jsonResponse } from "../../shared/http.ts";
import type { LabEnvironmentCapabilities } from "../types.ts";

/**
 * The Cascade providers Lab's page offers, read from Cascade's own declarations: each component's
 * registered providers, today's first, and for each the settings it declares a closed list of
 * values for (its model and voice), and the numeric settings the page offers (Gradium speech
 * input's turn rule) with their closed list of values or their limits, each with its default. A
 * provider Cascade registers appears on the page without a change to Lab, and Lab keeps no copy
 * of a provider's values, limits or defaults.
 */
const listedSettings = ["model", "voice"] as const;
type ListedSetting = (typeof listedSettings)[number];
type ListedValues = Readonly<{ values: readonly string[]; default: string }>;
/** The closed lists a provider declares among the settings the page offers. */
type ProviderLists = { model?: ListedValues; voice?: ListedValues };

const numberSettings = ["turnHorizon", "turnThreshold", "turnSteps"] as const;
type NumberSetting = (typeof numberSettings)[number];
/** A numeric setting's closed list of values, or its inclusive limits, with its default. */
type NumberOption =
  | Readonly<{ values: readonly number[]; default: number }>
  | Readonly<{ minimum: number; maximum: number; integer: boolean; default: number }>;
type ProviderNumbers = Partial<Record<NumberSetting, NumberOption>>;

/** A provider's declared default for a setting; null where it leaves the setting unsent. */
type DeclaredDefault = string | number | null;

type ProviderOption = Readonly<{
  provider: string;
  lists: Readonly<ProviderLists>;
  numbers: Readonly<ProviderNumbers>;
}>;

/**
 * What a Start may give, as Zod describes Cascade's settings schema: one group per component,
 * one variant per provider, each naming its provider in a constant and each closed list in an
 * enumeration.
 */
const startSettings = z.toJSONSchema(cascadeExecutionSettingsSchema, {
  io: "input",
  unrepresentable: "any",
});

function described(schema: z.core.JSONSchema._JSONSchema | undefined) {
  return typeof schema === "object" ? schema : undefined;
}

/**
 * A numeric setting as Zod describes it: an enumeration of numbers, or a number with both
 * limits, as the page's decoder accepts them. The provider's default must be one the setting
 * accepts.
 */
function numberOption(
  schema: z.core.JSONSchema._JSONSchema | undefined,
  fallback: DeclaredDefault | undefined,
): NumberOption | undefined {
  const declared = described(schema);
  if (declared === undefined || typeof fallback !== "number") return undefined;
  const values = declared.enum;
  if (values !== undefined)
    return values.every((value) => typeof value === "number") && values.includes(fallback)
      ? { values, default: fallback }
      : undefined;
  const { minimum, maximum } = declared;
  const integer = declared.type === "integer";
  if (
    (declared.type !== "number" && !integer) ||
    minimum === undefined ||
    maximum === undefined ||
    minimum >= maximum ||
    fallback < minimum ||
    fallback > maximum ||
    (integer && !Number.isInteger(fallback))
  )
    return undefined;
  return { minimum, maximum, integer, default: fallback };
}

function providerOption(
  component: keyof typeof cascadeProviderDeclarations,
  declaration: Readonly<{
    provider: string;
    defaults: Readonly<Partial<Record<ListedSetting | NumberSetting, DeclaredDefault>>>;
  }>,
): ProviderOption {
  const variant = described(startSettings.properties?.[component])?.oneOf?.find(
    (candidate) => described(candidate.properties?.provider)?.const === declaration.provider,
  );
  if (variant === undefined)
    throw new Error(`cascade_provider_settings_missing:${component}:${declaration.provider}`);
  const lists: ProviderLists = {};
  for (const setting of listedSettings) {
    const values = described(variant.properties?.[setting])?.enum?.filter(
      (value) => typeof value === "string",
    );
    const fallback = declaration.defaults[setting];
    if (values !== undefined && typeof fallback === "string" && values.includes(fallback))
      lists[setting] = { values, default: fallback };
  }
  const numbers: ProviderNumbers = {};
  for (const setting of numberSettings) {
    const option = numberOption(variant.properties?.[setting], declaration.defaults[setting]);
    if (option !== undefined) numbers[setting] = option;
  }
  return { provider: declaration.provider, lists, numbers };
}

export const labCascadeProviderOptions = {
  speechInput: cascadeProviderDeclarations.speechInput.map((declaration) =>
    providerOption("speechInput", declaration),
  ),
  languageModel: cascadeProviderDeclarations.languageModel.map((declaration) =>
    providerOption("languageModel", declaration),
  ),
  speechOutput: cascadeProviderDeclarations.speechOutput.map((declaration) =>
    providerOption("speechOutput", declaration),
  ),
};

export function handleLabCascadeProviders(
  request: Request,
  env: LabEnvironmentCapabilities,
): Response {
  return jsonResponse(request, env, labCascadeProviderOptions);
}
