import {
  labCascadeComponents,
  labCascadeListedSettings,
  labCascadeNumberSettings,
  type LabCascadeComponent,
  type LabCascadeListedSetting,
  type LabCascadeNumberSetting,
  type LabCascadeNumberSettingOption,
  type LabCascadeProviderOption,
  type LabCascadeProviderOptions,
} from "../data/cascadeProviderOptions";

/** The provider settings the Cascade panel offers, with the type of each one's value. */
type LabCascadeProviderSettings = Partial<
  Record<LabCascadeListedSetting, string> & Record<LabCascadeNumberSetting, number>
>;

/** One component's choice: its provider and that provider's offered settings. */
export type LabCascadeComponentChoice = Readonly<{
  provider: string;
  settings: Readonly<LabCascadeProviderSettings>;
}>;

/** The Cascade panel's values: one choice per component. */
export type LabCascadeChoices = Readonly<{
  speechInput: LabCascadeComponentChoice;
  languageModel: LabCascadeComponentChoice;
  speechOutput: LabCascadeComponentChoice;
}>;

/**
 * One edit of a Cascade panel control, which `applyLabCascadeChange` applies. The value is the
 * control's, as text; a numeric setting reads it as a number.
 */
export type LabCascadeChange = Readonly<{
  component: LabCascadeComponent;
  setting: "provider" | LabCascadeListedSetting | LabCascadeNumberSetting;
  value: string;
}>;

/** The settings a Lab Cascade Start sends: only the groups that differ from today's. */
export type LabCascadeExecutionSettings = Readonly<
  Partial<Record<LabCascadeComponent, Readonly<Record<string, string | number>>>>
>;

/** The most values a numeric control offers for a range; the panel picks evenly between limits. */
const rangeChoices = 20;

/**
 * The values a numeric setting's control offers: its closed list, or for a range, evenly spaced
 * values from the minimum to the maximum (each whole number of a short integer range), always
 * including the default.
 */
export function labCascadeNumberChoices(option: LabCascadeNumberSettingOption): readonly number[] {
  if ("values" in option) return option.values;
  const { minimum, maximum, integer } = option;
  const count = integer ? Math.min(maximum - minimum, rangeChoices) : rangeChoices;
  const values = new Set([option.default]);
  for (let index = 0; index <= count; index += 1) {
    const value = minimum + ((maximum - minimum) * index) / count;
    values.add(integer ? Math.round(value) : Math.round(value * 1e6) / 1e6);
  }
  return [...values].sort((left, right) => left - right);
}

/** Whether a number is a value the provider accepts for this setting. */
function acceptsNumber(option: LabCascadeNumberSettingOption, value: number): boolean {
  if ("values" in option) return option.values.includes(value);
  return (
    value >= option.minimum &&
    value <= option.maximum &&
    (!option.integer || Number.isInteger(value))
  );
}

function defaultChoice(option: LabCascadeProviderOption): LabCascadeComponentChoice {
  const settings: LabCascadeProviderSettings = {};
  for (const setting of labCascadeListedSettings) {
    const list = option.lists[setting];
    if (list !== undefined) settings[setting] = list.default;
  }
  for (const setting of labCascadeNumberSettings) {
    const number = option.numbers[setting];
    if (number !== undefined) settings[setting] = number.default;
  }
  return { provider: option.provider, settings };
}

/** Today's providers with their defaults: what a Cascade Run uses when its Start sends nothing. */
export function createLabCascadeChoices(options: LabCascadeProviderOptions): LabCascadeChoices {
  const today = (component: LabCascadeComponent) => {
    const [option] = options[component];
    if (option === undefined) throw new Error(`cascade_provider_missing:${component}`);
    return defaultChoice(option);
  };
  return {
    speechInput: today("speechInput"),
    languageModel: today("languageModel"),
    speechOutput: today("speechOutput"),
  };
}

function isNumberSetting(setting: LabCascadeChange["setting"]): setting is LabCascadeNumberSetting {
  return labCascadeNumberSettings.some((candidate) => candidate === setting);
}

/**
 * The panel's values after one edit. A newly chosen provider starts from its own defaults; a
 * value outside a control's options or limits changes nothing.
 */
export function applyLabCascadeChange(
  options: LabCascadeProviderOptions,
  current: LabCascadeChoices,
  { component, setting, value }: LabCascadeChange,
): LabCascadeChoices {
  const providers = options[component];
  if (setting === "provider") {
    const option = providers.find((candidate) => candidate.provider === value);
    return option === undefined ? current : { ...current, [component]: defaultChoice(option) };
  }
  const choice = current[component];
  const chosen = providers.find((candidate) => candidate.provider === choice.provider);
  const withSetting = (next: string | number): LabCascadeChoices => ({
    ...current,
    [component]: { ...choice, settings: { ...choice.settings, [setting]: next } },
  });
  if (isNumberSetting(setting)) {
    const number = chosen?.numbers[setting];
    const parsed = value.trim() === "" ? Number.NaN : Number(value);
    return number === undefined || !acceptsNumber(number, parsed) ? current : withSetting(parsed);
  }
  const list = chosen?.lists[setting];
  return list === undefined || !list.values.includes(value) ? current : withSetting(value);
}

/**
 * The execution settings of a Start with these choices: each group that differs from today's
 * provider and defaults, naming its provider and its offered settings. Choices equal to today's
 * send none, as Lab's Cascade Starts always did.
 */
export function labCascadeExecutionSettings(
  options: LabCascadeProviderOptions,
  choices: LabCascadeChoices,
): LabCascadeExecutionSettings | undefined {
  const today = createLabCascadeChoices(options);
  const offered = [...labCascadeListedSettings, ...labCascadeNumberSettings];
  const settings: Partial<Record<LabCascadeComponent, Readonly<Record<string, string | number>>>> =
    {};
  for (const component of labCascadeComponents) {
    const choice = choices[component];
    const base = today[component];
    if (
      choice.provider === base.provider &&
      offered.every((setting) => choice.settings[setting] === base.settings[setting])
    )
      continue;
    settings[component] = { provider: choice.provider, ...choice.settings };
  }
  return Object.keys(settings).length === 0 ? undefined : settings;
}
