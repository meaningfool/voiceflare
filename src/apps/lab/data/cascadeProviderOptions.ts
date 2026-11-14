import { z } from "zod";
import { boundary } from "../../../../tools/boundary-contracts/boundary-contracts.mjs";
import { createLabWorkerClient, type LabWorkerFetch } from "./labWorkerClient";

/**
 * The Cascade providers Lab offers, as Lab's Worker reads them from Cascade's own declarations:
 * one list per component, today's provider first, each provider with the settings it declares a
 * closed list of values for, the numeric settings the page offers with their values or limits,
 * and its default for each.
 */
export const labCascadeProviderOptionsPath = "/_api/cascade-providers";

export const labCascadeComponents = ["speechInput", "languageModel", "speechOutput"] as const;
export type LabCascadeComponent = (typeof labCascadeComponents)[number];

/** The provider settings Lab offers, where a provider declares a closed list of values. */
export const labCascadeListedSettings = ["model", "voice"] as const;
export type LabCascadeListedSetting = (typeof labCascadeListedSettings)[number];

const listedSettingSchema = z
  .strictObject({ values: z.array(z.string().min(1)).min(1), default: z.string().min(1) })
  .refine((list) => list.values.includes(list.default), "default must be one of the values");

/**
 * The numeric provider settings Lab offers where a provider declares them: Gradium speech input's
 * turn rule, which the user tunes by ear.
 */
export const labCascadeNumberSettings = ["turnHorizon", "turnThreshold", "turnSteps"] as const;
export type LabCascadeNumberSetting = (typeof labCascadeNumberSettings)[number];

/** A numeric setting with a closed list of values, such as Gradium's turn horizons. */
const numberValuesSchema = z
  .strictObject({ values: z.array(z.number()).min(1), default: z.number() })
  .refine((list) => list.values.includes(list.default), "default must be one of the values");

/** A numeric setting with inclusive limits, whole numbers only when `integer` is true. */
const numberRangeSchema = z
  .strictObject({
    minimum: z.number(),
    maximum: z.number(),
    integer: z.boolean(),
    default: z.number(),
  })
  .refine((range) => range.minimum < range.maximum, "minimum must be below maximum")
  .refine(
    (range) => range.default >= range.minimum && range.default <= range.maximum,
    "default must be within the limits",
  )
  .refine(
    (range) =>
      !range.integer ||
      [range.minimum, range.maximum, range.default].every((value) => Number.isInteger(value)),
    "an integer setting has whole limits and default",
  );

const numberSettingSchema = z.union([numberValuesSchema, numberRangeSchema]);

const providerOptionSchema = z.strictObject({
  provider: z.string().min(1),
  lists: z.strictObject({
    model: listedSettingSchema.optional(),
    voice: listedSettingSchema.optional(),
  }),
  numbers: z.strictObject({
    turnHorizon: numberSettingSchema.optional(),
    turnThreshold: numberSettingSchema.optional(),
    turnSteps: numberSettingSchema.optional(),
  }),
});

const providerListSchema = z
  .array(providerOptionSchema)
  .min(1)
  .refine(
    (options) => new Set(options.map((option) => option.provider)).size === options.length,
    "each provider appears once",
  );

const cascadeProviderOptionsSchema = z.strictObject({
  speechInput: providerListSchema,
  languageModel: providerListSchema,
  speechOutput: providerListSchema,
});

/**
 * One provider a component can run on: each listed setting's values, each numeric setting's
 * values or limits, and the provider's default for each.
 */
export type LabCascadeProviderOption = z.output<typeof providerOptionSchema>;
/** One numeric setting as a provider declares it: its closed list of values, or its limits. */
export type LabCascadeNumberSettingOption = z.output<typeof numberSettingSchema>;
export type LabCascadeProviderOptions = z.output<typeof cascadeProviderOptionsSchema>;

/** Lab Worker's answer to the page: the providers the page offers and their settings. */
export const decodeLabCascadeProviderOptions = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    cascadeProviderOptionsSchema,
  ),
  convert: (options): LabCascadeProviderOptions => options,
});

export function createLabCascadeProviderOptionsStore(baseUrl: string, fetchImpl?: LabWorkerFetch) {
  const client = createLabWorkerClient(baseUrl, fetchImpl);
  return {
    load: () => client.get(labCascadeProviderOptionsPath, decodeLabCascadeProviderOptions),
  };
}
export type LabCascadeProviderOptionsStore = ReturnType<
  typeof createLabCascadeProviderOptionsStore
>;
