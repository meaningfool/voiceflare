import {
  isReasoningEffort,
  realtimeExecutionSettingsSchema,
  runtimeReasoningEffortValues,
  type RealtimeExecutionSettings,
} from "./settings.ts";
import { z } from "zod";
import type { RealtimeUsageModels } from "./usage.ts";

import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import type { RuntimeReasoningEffort } from "../../shared/contracts/runtimeStart.ts";
import type { PreparedConversationNode } from "../../runtime/nodeContentContracts.ts";
import type { ExecutionSettingsPreparation } from "../../runtime/nativeContracts.ts";

const reasoningEffortSchema = z.enum(runtimeReasoningEffortValues).nullable();
/** A start request's execution settings arrive as JSON: inherited fields are not settings. */
const requestedSettingsSchema = z.preprocess(
  (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
  realtimeExecutionSettingsSchema,
);

export const REASONING_EFFORTS = runtimeReasoningEffortValues;
export { isReasoningEffort };

export type ReasoningEffort = RuntimeReasoningEffort;
export type OutputModality = "audio" | "text";

export type ProviderPromptReference = Readonly<{
  id: string;
  version?: string;
  variables?: Readonly<Record<string, string | number | boolean>>;
}>;

export type PreparedInstructions =
  | Readonly<{
      kind: "literal";
      text: string;
    }>
  | Readonly<{
      kind: "provider_prompt";
      prompt: ProviderPromptReference;
    }>;

export type PreparedTool = Readonly<{
  type: "function";
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export type PreparedToolChoice =
  | "auto"
  | "none"
  | Readonly<{
      type: "function";
      name: string;
    }>;

export type PreparedInputAudio = Readonly<{
  noiseReduction: Readonly<{
    type: string;
  }>;
  transcription: Readonly<{
    model: string;
    language: string;
  }>;
  turnDetection: Readonly<{
    type: string;
    eagerness?: string;
    threshold?: number;
    createResponse: boolean;
    interruptResponse: boolean;
  }>;
}>;

export type PreparedOutputAudio = Readonly<{
  voice: string;
  speed: number;
}>;

export type PreparedModelSession = Readonly<{
  runId: string;
  model: string;
  instructions: PreparedInstructions;
  operationalInstructions: string;
  reasoning: Readonly<{
    effort: ReasoningEffort;
  }> | null;
  outputModalities: readonly OutputModality[];
  tools: readonly PreparedTool[];
  /** Null sends no tool choice, as a session without tools under the Gate's options does. */
  toolChoice: PreparedToolChoice | null;
  maxOutputTokens: number | "inf";
  truncation: "auto" | "disabled";
  inputAudio: PreparedInputAudio;
  outputAudio: PreparedOutputAudio;
  include: readonly string[];
  tracing: Readonly<Record<string, unknown>> | null;
}>;

type MutableProviderPromptReference = {
  id: string;
  version?: string;
  variables?: Readonly<Record<string, string | number | boolean>>;
};

export type ProviderRealtimeSession = Readonly<Record<string, unknown>>;

export type PreparedModelSessionSummary = Readonly<{
  model: string;
  voice: string;
  maxOutputTokens: number | "inf";
  reasoningEffort?: ReasoningEffort;
  inputNoiseReduction: Readonly<{ type: string }>;
  turnDetection: Readonly<{
    type: string;
    eagerness?: string;
    threshold?: number;
    createResponse: boolean;
    interruptResponse: boolean;
  }>;
}>;

type PreparedTurnDetectionSummary = PreparedModelSessionSummary["turnDetection"];

type MutablePreparedTurnDetectionSummary = {
  type: string;
  eagerness?: string;
  threshold?: number;
  createResponse: boolean;
  interruptResponse: boolean;
};

type MutablePreparedModelSessionSummary = {
  model: string;
  voice: string;
  maxOutputTokens: number | "inf";
  reasoningEffort?: ReasoningEffort;
  inputNoiseReduction: Readonly<{ type: string }>;
  turnDetection: PreparedTurnDetectionSummary;
};

export type ProviderRealtimeSessionSummary = Readonly<Record<string, unknown>>;

export const REALTIME_MODEL = "gpt-realtime-2.1";
export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const VOICE = "marin";
const INPUT_NOISE_REDUCTION_TYPE = "far_field";
const SEMANTIC_VAD_EAGERNESS = "medium";

const nonBlank = z.string().min(1);
const realtimeSessionSettingsSchema = z.strictObject({
  model: nonBlank,
  reasoning: z.strictObject({ effort: z.enum(runtimeReasoningEffortValues) }).nullable(),
  outputModalities: z.array(z.enum(["audio", "text"])),
  toolChoice: z.union([
    z.enum(["auto", "none"]),
    z.strictObject({ type: z.literal("function"), name: nonBlank }),
  ]),
  maxOutputTokens: z.union([z.number().int().positive(), z.literal("inf")]),
  truncation: z.enum(["auto", "disabled"]),
  inputAudio: z.strictObject({
    noiseReduction: z.strictObject({ type: nonBlank }),
    transcription: z.strictObject({ model: nonBlank, language: nonBlank }),
    turnDetection: z.strictObject({
      type: nonBlank,
      eagerness: nonBlank.exactOptional(),
      threshold: z.number().exactOptional(),
      createResponse: z.boolean(),
      interruptResponse: z.boolean(),
    }),
  }),
  outputAudio: z.strictObject({ voice: nonBlank, speed: z.number() }),
  include: z.array(z.string()),
  tracing: z.record(z.string(), z.json()).nullable(),
});

/**
 * Realtime's prepared settings: its session without the Conversation's content. Runtime stores
 * them as they are and hands them back after a restart; Realtime composes them with the opening
 * content into the session it creates the call with.
 */
export type RealtimeSessionSettings = z.output<typeof realtimeSessionSettingsSchema>;

/**
 * Realtime's prepared settings as Runtime stored them: the kit's own persisted format, which it
 * reads back at call creation and, after a restart, for each node it enters.
 */
export const decodeRealtimeSessionSettings = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    realtimeSessionSettingsSchema,
  ),
  convert: (settings): RealtimeSessionSettings => settings,
});

/** The models that Realtime's usage entries name, as its settings choose them. */
export function realtimeUsageModels(settings: RealtimeSessionSettings): RealtimeUsageModels {
  return {
    speechToSpeech: settings.model,
    speechToText: settings.inputAudio.transcription.model,
  };
}

const providerRealtimeSessionConfigSchema = z.looseObject({
  model: z.unknown().optional(),
  voice: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  reasoning_effort: z.unknown().optional(),
  reasoningEffort: z.unknown().optional(),
  audio: z.unknown().optional(),
  input_audio_noise_reduction: z.unknown().optional(),
  input_noise_reduction: z.unknown().optional(),
  turn_detection: z.unknown().optional(),
});
const providerRealtimeSessionEventSchema = z.looseObject({
  type: z.enum(["session.created", "session.updated"]),
  session: providerRealtimeSessionConfigSchema,
});

interface ProviderRealtimeSessionEventSummarizer {
  (event: unknown): ProviderRealtimeSessionSummary | null;
}

interface ProviderRealtimeSessionConfigSummarizer {
  (value: unknown): ProviderRealtimeSessionSummary;
}

const providerRealtimeSessionConfigBoundary = boundary.tolerant({
  source: "provider Realtime session configuration",
  variants: [
    {
      schema: providerRealtimeSessionConfigSchema,
      convert: (value) => buildRealtimeSessionSummary(value),
    },
  ],
  otherwise: failure("invalid_provider_realtime_session"),
});

const providerRealtimeSessionEventBoundary = boundary.tolerant({
  source: "provider Realtime session event",
  variants: [
    {
      schema: providerRealtimeSessionEventSchema,
      convert: (event) => buildRealtimeSessionSummary(event.session),
    },
  ],
  otherwise: failure("invalid_provider_realtime_session_event"),
});

export function selectInterviewModels(): RealtimeUsageModels {
  return { speechToSpeech: REALTIME_MODEL, speechToText: TRANSCRIPTION_MODEL };
}

/**
 * Prepares Realtime's settings from the Run's start choices: its reasoning effort and the start
 * request's execution settings, Lab's Realtime settings when given. Execution settings that are
 * not Realtime's are refused before any provider work. A requested reasoning effort of `none`
 * sends no reasoning effort, as no effort requested does.
 */
export function prepareRealtimeSettings(
  input: Readonly<{
    reasoningEffort?: ReasoningEffort | null;
    requested?: ExecutionSettingsPreparation["requested"];
  }>,
  models: RealtimeUsageModels = selectInterviewModels(),
): RealtimeSessionSettings {
  const requested =
    input.requested === undefined ? undefined : requestedSettingsSchema.safeParse(input.requested);
  if (requested !== undefined && !requested.success) throw new Error("invalid_execution_settings");
  const reasoningEffort = reasoningEffortSchema.parse(input.reasoningEffort ?? null);
  const settings = requested?.data;
  return {
    model: settings?.model ?? models.speechToSpeech,
    reasoning:
      reasoningEffort === null || reasoningEffort === "none" ? null : { effort: reasoningEffort },
    outputModalities: ["audio"],
    toolChoice: "auto",
    maxOutputTokens: settings?.maxOutputTokens ?? 700,
    truncation: settings?.truncation ?? "auto",
    inputAudio: {
      noiseReduction: {
        type: settings?.inputNoiseReduction ?? INPUT_NOISE_REDUCTION_TYPE,
      },
      transcription: {
        model: models.speechToText,
        language: "en",
      },
      turnDetection: prepareTurnDetection(settings),
    },
    outputAudio: {
      voice: settings?.voice ?? VOICE,
      speed: settings?.speed ?? 1,
    },
    include: [],
    tracing: null,
  };
}

/** The session Realtime creates its call with: the opening content under its settings. */
export function composeRealtimeSession(
  runId: string,
  content: PreparedConversationNode,
  settings: RealtimeSessionSettings,
): PreparedModelSession {
  return {
    runId,
    model: settings.model,
    instructions: content.instructions,
    operationalInstructions: content.operationalInstructions,
    reasoning: settings.reasoning,
    outputModalities: settings.outputModalities,
    tools: content.tools,
    toolChoice: settings.toolChoice,
    maxOutputTokens: settings.maxOutputTokens,
    truncation: settings.truncation,
    inputAudio: settings.inputAudio,
    outputAudio: settings.outputAudio,
    include: settings.include,
    tracing: settings.tracing,
  };
}

export function prepareTurnDetection(
  settings: Pick<RealtimeExecutionSettings, "semanticVadEagerness"> | undefined,
): PreparedInputAudio["turnDetection"] {
  return {
    type: "semantic_vad",
    eagerness: settings?.semanticVadEagerness ?? SEMANTIC_VAD_EAGERNESS,
    createResponse: true,
    interruptResponse: false,
  };
}

export function toProviderRealtimeSession(session: PreparedModelSession): ProviderRealtimeSession {
  const instructions =
    session.instructions.kind === "literal"
      ? session.instructions.text
      : session.operationalInstructions;
  let prompt: ProviderPromptReference | undefined;

  if (session.instructions.kind === "provider_prompt") {
    const providerPrompt: MutableProviderPromptReference = {
      id: session.instructions.prompt.id,
    };

    if (session.instructions.prompt.version !== undefined) {
      providerPrompt.version = session.instructions.prompt.version;
    }
    if (session.instructions.prompt.variables !== undefined) {
      providerPrompt.variables = session.instructions.prompt.variables;
    }

    prompt = providerPrompt;
  }

  return omitUndefined({
    type: "realtime",
    model: session.model,
    output_modalities: [...session.outputModalities],
    instructions,
    prompt,
    reasoning: session.reasoning === null ? undefined : { effort: session.reasoning.effort },
    tools: session.tools.map((tool) => ({
      type: tool.type,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    tool_choice: session.toolChoice ?? undefined,
    audio: {
      input: {
        noise_reduction:
          session.inputAudio.noiseReduction.type === "off"
            ? null
            : { type: session.inputAudio.noiseReduction.type },
        transcription: {
          model: session.inputAudio.transcription.model,
          language: session.inputAudio.transcription.language,
        },
        turn_detection: omitUndefined({
          type: session.inputAudio.turnDetection.type,
          eagerness: session.inputAudio.turnDetection.eagerness,
          threshold: session.inputAudio.turnDetection.threshold,
          create_response: session.inputAudio.turnDetection.createResponse,
          interrupt_response: session.inputAudio.turnDetection.interruptResponse,
        }),
      },
      output: {
        voice: session.outputAudio.voice,
        speed: session.outputAudio.speed,
      },
    },
    include: session.include.length === 0 ? undefined : [...session.include],
    tracing: session.tracing,
    truncation: session.truncation,
    max_output_tokens: session.maxOutputTokens,
  });
}

/** The summary of Realtime's settings, or of a session's, that Runtime keeps for diagnostics. */
export function summarizePreparedModelSession(
  session: Pick<
    PreparedModelSession,
    "model" | "reasoning" | "maxOutputTokens" | "inputAudio" | "outputAudio"
  >,
): PreparedModelSessionSummary {
  const turnDetection: MutablePreparedTurnDetectionSummary = {
    type: session.inputAudio.turnDetection.type,
    createResponse: session.inputAudio.turnDetection.createResponse,
    interruptResponse: session.inputAudio.turnDetection.interruptResponse,
  };

  if (session.inputAudio.turnDetection.eagerness !== undefined) {
    turnDetection.eagerness = session.inputAudio.turnDetection.eagerness;
  }
  if (session.inputAudio.turnDetection.threshold !== undefined) {
    turnDetection.threshold = session.inputAudio.turnDetection.threshold;
  }

  const summary: MutablePreparedModelSessionSummary = {
    model: session.model,
    voice: session.outputAudio.voice,
    maxOutputTokens: session.maxOutputTokens,
    inputNoiseReduction: {
      type: session.inputAudio.noiseReduction.type,
    },
    turnDetection,
  };

  if (session.reasoning !== null) summary.reasoningEffort = session.reasoning.effort;

  return summary;
}

export const summarizeProviderRealtimeSessionEvent: ProviderRealtimeSessionEventSummarizer = (
  event,
) => {
  const parsed = providerRealtimeSessionEventBoundary(event);

  if (!parsed.ok) {
    return null;
  }

  const summary = parsed.value;
  return Object.keys(summary).length === 0 ? null : summary;
};

export const summarizeRealtimeSessionConfig: ProviderRealtimeSessionConfigSummarizer = (value) => {
  const parsed = providerRealtimeSessionConfigBoundary(value);
  return parsed.ok ? parsed.value : {};
};

function buildRealtimeSessionSummary(
  value: z.output<typeof providerRealtimeSessionConfigSchema>,
): ProviderRealtimeSessionSummary {
  const audio = asRecord(value.audio);
  const audioInput = asRecord(audio?.input);
  const audioOutput = asRecord(audio?.output);
  const reasoning = asRecord(value.reasoning);
  const noiseReduction =
    audioInput?.noise_reduction ?? value.input_audio_noise_reduction ?? value.input_noise_reduction;
  const turnDetection = audioInput?.turn_detection ?? value.turn_detection;

  return omitUndefined({
    model: asOptionalString(value.model),
    voice: asOptionalString(audioOutput?.voice ?? value.voice),
    reasoningEffort: asOptionalString(
      reasoning?.effort ?? value.reasoning_effort ?? value.reasoningEffort,
    ),
    inputNoiseReduction: summarizeInputNoiseReduction(noiseReduction),
    turnDetection: summarizeTurnDetection(turnDetection),
  });
}

function summarizeInputNoiseReduction<Value>(value: Value): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return omitUndefined({
    type: asOptionalString(value.type),
  });
}

function summarizeTurnDetection<Value>(value: Value): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return omitUndefined({
    type: asOptionalString(value.type),
    createResponse: asOptionalBoolean(value.create_response ?? value.createResponse),
    interruptResponse: asOptionalBoolean(value.interrupt_response ?? value.interruptResponse),
    eagerness: asOptionalString(value.eagerness),
    threshold: asOptionalNumber(value.threshold),
  });
}

function asOptionalString<Value>(value: Value): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalBoolean<Value>(value: Value): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber<Value>(value: Value): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord<Value>(value: Value): (Value & Record<string, unknown>) | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
