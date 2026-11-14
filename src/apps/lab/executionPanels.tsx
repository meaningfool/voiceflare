import { Fragment, type ReactNode } from "react";

import { Field, FieldLabel } from "@/apps/lab/components/ui/field";
import {
  labCascadeNumberChoices,
  type LabCascadeChange,
  type LabCascadeChoices,
} from "./cascadeClient/labCascadeSettings";
import {
  labCascadeComponents,
  labCascadeListedSettings,
  labCascadeNumberSettings,
  type LabCascadeComponent,
  type LabCascadeNumberSetting,
  type LabCascadeProviderOptions,
} from "./data/cascadeProviderOptions";
import type { LabReasoningEffort } from "./interviewClient";
import { LabSelectField } from "./LabSelectField";
import type { LabRealtimeSettings } from "./realtimeClient/labRealtimeSettings";

/**
 * What an execution shows on the Lab page beside the selected Conversation's editor: its heading,
 * its settings, and the page features today's page of that execution has.
 */
export type LabExecutionPanel = Readonly<{
  heading: string;
  /** The page's accessible name. */
  label: string;
  /** The prefix of the page's section ids. */
  idPrefix: string;
  /** The execution's settings, shown in Settings after the interview duration. */
  settings: ReactNode;
  /** Lab's saved prompts: choose, reload and save; the instructions stay editable while live. */
  savedPrompts: boolean;
  /** A note that the Goodbye limit follows interviewing time, for a Conversation with a Goodbye. */
  closingNote: boolean;
  /** Where the live Conversation state appears; in Settings, the countdown appears with it. */
  liveFacts: "settings" | "interview";
}>;

/** The Cascade panel, holding each component's provider and that provider's listed settings. */
export function cascadeExecutionPanel(props: CascadeSettingsProps): LabExecutionPanel {
  return {
    heading: "Cascade Interview",
    label: "Cascade Live Interview",
    idPrefix: "cascade",
    settings: <CascadeSettings {...props} />,
    savedPrompts: false,
    closingNote: false,
    liveFacts: "interview",
  };
}

export type CascadeSettingsProps = Readonly<{
  /** The providers Cascade declares, once Lab's Worker answered; null while loading or failed. */
  options: LabCascadeProviderOptions | null;
  optionsError: string | null;
  choices: LabCascadeChoices | null;
  disabled: boolean;
  onChange: (change: LabCascadeChange) => void;
}>;

const cascadeComponentLabels = {
  speechInput: "Speech input",
  languageModel: "Language model",
  speechOutput: "Speech output",
} as const satisfies Record<LabCascadeComponent, string>;

const cascadeNumberSettingLabels = {
  turnHorizon: "turn horizon (s)",
  turnThreshold: "turn threshold",
  turnSteps: "turn steps",
} as const satisfies Record<LabCascadeNumberSetting, string>;

/**
 * One provider choice per component, then the chosen provider's model and voice where it
 * declares a list, and its numeric settings the page offers, such as Gradium speech input's turn
 * rule, each a choice among valid values. Until the providers load, a Start uses today's
 * providers.
 */
function CascadeSettings({
  options,
  optionsError,
  choices,
  disabled,
  onChange,
}: CascadeSettingsProps) {
  if (options === null || choices === null)
    return optionsError === null ? (
      <p>Loading Cascade providers.</p>
    ) : (
      <p role="alert">{optionsError}</p>
    );
  return (
    <>
      {labCascadeComponents.map((component) => {
        const label = cascadeComponentLabels[component];
        const choice = choices[component];
        const chosen = options[component].find((option) => option.provider === choice.provider);
        return (
          <Fragment key={component}>
            <LabSelectField
              disabled={disabled}
              label={`${label} provider`}
              name={`cascade.${component}.provider`}
              onValueChange={(value) => onChange({ component, setting: "provider", value })}
              options={options[component].map(({ provider }) => ({
                label: provider,
                value: provider,
              }))}
              value={choice.provider}
            />
            {labCascadeListedSettings.map((setting) => {
              const list = chosen?.lists[setting];
              return list === undefined ? null : (
                <LabSelectField
                  key={setting}
                  disabled={disabled}
                  label={`${label}: ${setting}`}
                  name={`cascade.${component}.${setting}`}
                  onValueChange={(value) => onChange({ component, setting, value })}
                  options={list.values.map((value) => ({ label: value, value }))}
                  value={choice.settings[setting] ?? list.default}
                />
              );
            })}
            {labCascadeNumberSettings.map((setting) => {
              const number = chosen?.numbers[setting];
              return number === undefined ? null : (
                <LabSelectField
                  key={setting}
                  disabled={disabled}
                  label={`${label}: ${cascadeNumberSettingLabels[setting]}`}
                  name={`cascade.${component}.${setting}`}
                  onValueChange={(value) => onChange({ component, setting, value })}
                  options={labCascadeNumberChoices(number).map((value) => ({
                    label: String(value),
                    value: String(value),
                  }))}
                  value={String(choice.settings[setting] ?? number.default)}
                />
              );
            })}
          </Fragment>
        );
      })}
    </>
  );
}

/** The Realtime panel, holding the Realtime run settings and the reasoning effort. */
export function realtimeExecutionPanel(props: RealtimeSettingsProps): LabExecutionPanel {
  return {
    heading: "Interview",
    label: "Live Interview",
    idPrefix: "live",
    settings: <RealtimeSettings {...props} />,
    savedPrompts: true,
    closingNote: true,
    liveFacts: "settings",
  };
}

/** The Realtime panel's values. */
export type RealtimeRunSettings = Readonly<{
  settings: LabRealtimeSettings;
  reasoningEffort: LabReasoningEffort;
  /** The output limit as typed, which may not yet be a valid limit. */
  outputCapInput: string;
}>;

export function createRealtimeRunSettings(): RealtimeRunSettings {
  return {
    settings: {
      model: "gpt-realtime-2.1",
      voice: "marin",
      speed: 1,
      inputNoiseReduction: "far_field",
      semanticVadEagerness: "medium",
      maxOutputTokens: 700,
      truncation: "auto",
    },
    reasoningEffort: "low",
    outputCapInput: "700",
  };
}

/** One edit of a Realtime panel control, which `applyRealtimeSettingsChange` applies. */
export type RealtimeSettingsChange =
  | { setting: "model" | "voice" | "inputNoiseReduction" | "semanticVadEagerness"; value: string }
  | { setting: "reasoningEffort"; value: string }
  | { setting: "speed"; value: number }
  | { setting: "outputCapMode"; value: string }
  | { setting: "outputCapInput"; value: string }
  | { setting: "truncation"; value: string };

const reasoningEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly LabReasoningEffort[];
const realtimeModels = [
  "gpt-realtime-2",
  "gpt-realtime-2.1",
] as const satisfies readonly LabRealtimeSettings["model"][];
const voices = [
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
] as const satisfies readonly LabRealtimeSettings["voice"][];
const noiseReductions = [
  "off",
  "near_field",
  "far_field",
] as const satisfies readonly LabRealtimeSettings["inputNoiseReduction"][];
const vadEagernesses = [
  "low",
  "medium",
  "high",
] as const satisfies readonly LabRealtimeSettings["semanticVadEagerness"][];

function choose<Value extends string>(options: readonly Value[], value: string): Value | undefined {
  return options.find((candidate) => candidate === value);
}

/** The panel's values after one edit; a value outside a control's options changes nothing. */
export function applyRealtimeSettingsChange(
  current: RealtimeRunSettings,
  change: RealtimeSettingsChange,
): RealtimeRunSettings {
  const withSetting = (next: Partial<LabRealtimeSettings>): RealtimeRunSettings => ({
    ...current,
    settings: { ...current.settings, ...next },
  });
  switch (change.setting) {
    case "model": {
      const model = choose(realtimeModels, change.value);
      return model === undefined ? current : withSetting({ model });
    }
    case "voice": {
      const voice = choose(voices, change.value);
      return voice === undefined ? current : withSetting({ voice });
    }
    case "inputNoiseReduction": {
      const inputNoiseReduction = choose(noiseReductions, change.value);
      return inputNoiseReduction === undefined ? current : withSetting({ inputNoiseReduction });
    }
    case "semanticVadEagerness": {
      const semanticVadEagerness = choose(vadEagernesses, change.value);
      return semanticVadEagerness === undefined ? current : withSetting({ semanticVadEagerness });
    }
    case "reasoningEffort": {
      const reasoningEffort = choose(reasoningEfforts, change.value);
      return reasoningEffort === undefined ? current : { ...current, reasoningEffort };
    }
    case "speed":
      return Number.isFinite(change.value) && change.value >= 0.25 && change.value <= 1.5
        ? withSetting({ speed: change.value })
        : current;
    case "outputCapMode": {
      if (change.value === "inf") return withSetting({ maxOutputTokens: "inf" });
      if (change.value !== "finite") return current;
      const parsed = Number(current.outputCapInput);
      return isValidOutputCap(parsed)
        ? withSetting({ maxOutputTokens: parsed })
        : { ...withSetting({ maxOutputTokens: 700 }), outputCapInput: "700" };
    }
    case "outputCapInput": {
      const parsed = Number(change.value);
      return isValidOutputCap(parsed)
        ? { ...withSetting({ maxOutputTokens: parsed }), outputCapInput: change.value }
        : { ...current, outputCapInput: change.value };
    }
    case "truncation":
      return change.value === "auto" || change.value === "disabled"
        ? withSetting({ truncation: change.value })
        : current;
  }
}

/** Whether the Realtime panel lets a run start: a finite output limit must be valid as typed. */
export function realtimeSettingsReady({ settings, outputCapInput }: RealtimeRunSettings): boolean {
  return settings.maxOutputTokens === "inf" || isValidOutputCap(Number(outputCapInput));
}

function isValidOutputCap(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 4096;
}

function isValidOutputCapInput(value: string): boolean {
  return value.trim().length > 0 && isValidOutputCap(Number(value));
}

export type RealtimeSettingsProps = Readonly<{
  values: RealtimeRunSettings;
  /** Locks the output limit and truncation, which a live run may still change for the next run. */
  outputSettingsDisabled: boolean;
  onChange: (change: RealtimeSettingsChange) => void;
}>;

function RealtimeSettings({ values, outputSettingsDisabled, onChange }: RealtimeSettingsProps) {
  const { settings, reasoningEffort, outputCapInput } = values;
  return (
    <>
      <LabSelectField
        disabled={false}
        label="Model"
        name="realtimeModel"
        onValueChange={(value) => onChange({ setting: "model", value })}
        options={realtimeModels.map((model) => ({ label: model, value: model }))}
        value={settings.model}
      />
      <LabSelectField
        disabled={false}
        label="Reasoning effort"
        name="reasoningEffort"
        onValueChange={(value) => onChange({ setting: "reasoningEffort", value })}
        options={reasoningEfforts.map((effort) => ({ label: effort, value: effort }))}
        value={reasoningEffort}
      />
      <LabSelectField
        disabled={false}
        label="Voice"
        name="voice"
        onValueChange={(value) => onChange({ setting: "voice", value })}
        options={voices.map((voice) => ({ label: voice, value: voice }))}
        value={settings.voice}
      />
      <Field className="run-setting-field">
        <FieldLabel htmlFor="lab-speech-speed">Speaking speed</FieldLabel>
        <input
          className="live-speed-input"
          id="lab-speech-speed"
          name="speed"
          type="number"
          min="0.25"
          max="1.5"
          step="0.05"
          value={settings.speed}
          onChange={(event) =>
            onChange({ setting: "speed", value: event.currentTarget.valueAsNumber })
          }
        />
      </Field>
      <LabSelectField
        disabled={false}
        label="Input noise reduction"
        name="inputNoiseReduction"
        onValueChange={(value) => onChange({ setting: "inputNoiseReduction", value })}
        options={noiseReductions.map((mode) => ({
          label: mode === "off" ? "Off" : mode === "near_field" ? "Near field" : "Far field",
          value: mode,
        }))}
        value={settings.inputNoiseReduction}
      />
      <LabSelectField
        disabled={false}
        label="Semantic VAD eagerness"
        name="semanticVadEagerness"
        onValueChange={(value) => onChange({ setting: "semanticVadEagerness", value })}
        options={vadEagernesses.map((eagerness) => ({ label: eagerness, value: eagerness }))}
        value={settings.semanticVadEagerness}
      />
      <LabSelectField
        disabled={outputSettingsDisabled}
        label="Output limit"
        name="outputCapMode"
        onValueChange={(value) => onChange({ setting: "outputCapMode", value })}
        options={[
          { label: "Finite", value: "finite" },
          { label: "Unlimited", value: "inf" },
        ]}
        value={settings.maxOutputTokens === "inf" ? "inf" : "finite"}
      />
      {settings.maxOutputTokens === "inf" ? null : (
        <Field className="run-setting-field">
          <FieldLabel htmlFor="output-token-cap">Output tokens per response</FieldLabel>
          <input
            id="output-token-cap"
            aria-invalid={!isValidOutputCapInput(outputCapInput)}
            className="live-number-input"
            type="number"
            disabled={outputSettingsDisabled}
            min={1}
            max={4096}
            step={1}
            value={outputCapInput}
            onChange={(event) =>
              onChange({ setting: "outputCapInput", value: event.currentTarget.value })
            }
          />
          {!isValidOutputCapInput(outputCapInput) ? (
            <p role="alert">Enter a whole number from 1 to 4096.</p>
          ) : null}
        </Field>
      )}
      <LabSelectField
        disabled={outputSettingsDisabled}
        label="Conversation truncation"
        name="truncation"
        onValueChange={(value) => onChange({ setting: "truncation", value })}
        options={[
          { label: "Auto", value: "auto" },
          { label: "Disabled", value: "disabled" },
        ]}
        value={settings.truncation}
      />
    </>
  );
}
