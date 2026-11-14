import { z } from "zod";
import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import type {
  ConversationUsageEvidence,
  ExpectedUsageEvidence,
  RuntimeUsageNormalization,
} from "../../runtime/runtimeUsage.ts";
import type {
  RuntimeUsageObservation,
  UsageDeclaration,
} from "../../shared/contracts/runtimeTerminalResult.ts";

const speechMeasures = [
  "uncached_input_text",
  "cached_input_text",
  "uncached_input_audio",
  "cached_input_audio",
  "output_text",
  "output_audio",
] as const;
const transcriptionMeasures = ["input_audio", "input_text", "output_text"] as const;

/**
 * What Realtime reports: OpenAI's tokens of each response of its speech-to-speech model, and of
 * each participant transcription of its transcription model.
 */
export const realtimeUsageDeclarations: readonly UsageDeclaration[] = Object.freeze([
  ...speechMeasures.map((measure) => ({
    componentRole: "speech_to_speech",
    provider: "openai",
    measure,
    unit: "token" as const,
  })),
  ...transcriptionMeasures.map((measure) => ({
    componentRole: "speech_to_text",
    provider: "openai",
    measure,
    unit: "token" as const,
  })),
]);

/** The models Realtime's usage entries name: its speech-to-speech and its transcription model. */
export type RealtimeUsageModels = Readonly<{
  speechToSpeech: string;
  speechToText: string;
}>;

/** One usage entry as OpenAI reports it, before Realtime names the model that produced it. */
type RealtimeUsageMeasurement = Omit<RuntimeUsageObservation, "model">;

const count = z.number().int().safe().nonnegative();
const ownJson = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => z.json().parse(JSON.parse(JSON.stringify(value))), schema);
const realtimeUsageSchema = z
  .looseObject({
    total_tokens: count,
    input_tokens: count,
    output_tokens: count,
    input_token_details: z.looseObject({
      text_tokens: count,
      audio_tokens: count,
      image_tokens: count,
      cached_tokens: count,
      cached_tokens_details: z.looseObject({
        text_tokens: count,
        audio_tokens: count,
        image_tokens: count,
      }),
    }),
    output_token_details: z.looseObject({
      text_tokens: count,
      audio_tokens: count,
    }),
  })
  .superRefine((usage, context) => {
    const input = usage.input_token_details;
    const cached = input.cached_tokens_details;
    const output = usage.output_token_details;
    if (
      usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
      usage.input_tokens !== input.text_tokens + input.audio_tokens + input.image_tokens ||
      usage.output_tokens !== output.text_tokens + output.audio_tokens ||
      input.cached_tokens !== cached.text_tokens + cached.audio_tokens + cached.image_tokens ||
      input.image_tokens !== 0 ||
      cached.image_tokens !== 0 ||
      cached.text_tokens > input.text_tokens ||
      cached.audio_tokens > input.audio_tokens
    ) {
      context.addIssue({ code: "custom", message: "Realtime usage totals are inconsistent." });
    }
  });

const transcriptionUsageSchema = z
  .looseObject({
    type: z.literal("tokens"),
    total_tokens: count,
    input_tokens: count,
    output_tokens: count,
    input_token_details: z.looseObject({
      audio_tokens: count,
      text_tokens: count,
    }),
  })
  .superRefine((usage, context) => {
    if (
      usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
      usage.input_tokens !==
        usage.input_token_details.audio_tokens + usage.input_token_details.text_tokens
    ) {
      context.addIssue({ code: "custom", message: "Transcription usage totals are inconsistent." });
    }
  });

// OpenAI owns these independently evolving provider payloads. The accepted
// variants are deliberately finite; unknown fields are ignored, while any
// incompatible or internally inconsistent operation is rejected as a whole.
const realtimeUsageBoundary = boundary.tolerant({
  source: "OpenAI Realtime response.done usage",
  variants: [
    {
      schema: ownJson(realtimeUsageSchema),
      convert: (usage) => {
        const input = usage.input_token_details;
        const cached = input.cached_tokens_details;
        const output = usage.output_token_details;
        return compact([
          speechMeasurement("uncached_input_text", input.text_tokens - cached.text_tokens),
          speechMeasurement("cached_input_text", cached.text_tokens),
          speechMeasurement("uncached_input_audio", input.audio_tokens - cached.audio_tokens),
          speechMeasurement("cached_input_audio", cached.audio_tokens),
          speechMeasurement("output_text", output.text_tokens),
          speechMeasurement("output_audio", output.audio_tokens),
        ]);
      },
    },
  ],
  otherwise: failure("invalid_openai_realtime_usage"),
});

const transcriptionUsageBoundary = boundary.tolerant({
  source: "OpenAI Realtime participant transcription terminal usage",
  variants: [
    {
      schema: ownJson(transcriptionUsageSchema),
      convert: (usage) =>
        compact([
          transcriptionMeasurement("input_audio", usage.input_token_details.audio_tokens),
          transcriptionMeasurement("input_text", usage.input_token_details.text_tokens),
          transcriptionMeasurement("output_text", usage.output_tokens),
        ]),
    },
  ],
  otherwise: failure("invalid_openai_transcription_usage"),
});

/**
 * A response's `response.done` usage as Realtime's usage entries, naming the speech-to-speech
 * model. Without the model, or with usage it does not accept, the response's usage is invalid.
 */
export function normalizeRealtimeUsage<Value>(
  value: Value,
  models: RealtimeUsageModels | undefined,
): RuntimeUsageNormalization {
  const parsed = realtimeUsageBoundary(value);
  return attribute(parsed.ok ? parsed.value : null, models?.speechToSpeech);
}

/**
 * A participant transcription's terminal usage as Realtime's usage entries, naming the
 * transcription model. Without the model, or with usage it does not accept, it is invalid.
 */
export function normalizeTranscriptionUsage<Value>(
  value: Value,
  models: RealtimeUsageModels | undefined,
): RuntimeUsageNormalization {
  const parsed = transcriptionUsageBoundary(value);
  return attribute(parsed.ok ? parsed.value : null, models?.speechToText);
}

function attribute(
  measurements: readonly RealtimeUsageMeasurement[] | null,
  model: string | undefined,
): RuntimeUsageNormalization {
  if (measurements === null || model === undefined) return { status: "invalid" };
  return {
    status: "valid",
    observations: measurements.map((measurement) => ({ ...measurement, model })),
  };
}

function speechMeasurement(
  measure: (typeof speechMeasures)[number],
  quantity: number,
): RealtimeUsageMeasurement {
  return {
    componentRole: "speech_to_speech",
    provider: "openai",
    measure,
    unit: "token",
    quantity,
  };
}

function transcriptionMeasurement(
  measure: (typeof transcriptionMeasures)[number],
  quantity: number,
): RealtimeUsageMeasurement {
  return {
    componentRole: "speech_to_text",
    provider: "openai",
    measure,
    unit: "token",
    quantity,
  };
}

function compact(
  measurements: readonly RealtimeUsageMeasurement[],
): readonly RealtimeUsageMeasurement[] {
  return measurements.filter((item) => item.quantity !== 0);
}

/** A response that started will report its usage when it is done. */
export function expectedResponseUsage(responseId: string): readonly ConversationUsageEvidence[] {
  return [{ status: "expected", componentRole: "speech_to_speech", key: responseKey(responseId) }];
}

/** A done or cancelled response settles its usage with its `response.done` usage. */
export function settledResponseUsage(
  responseId: string,
  usage: RuntimeUsageNormalization,
): readonly ConversationUsageEvidence[] {
  return [settled({ componentRole: "speech_to_speech", key: responseKey(responseId) }, usage)];
}

/** A committed participant item will report the usage of its transcription. */
export function expectedTranscriptionUsage(itemId: string): readonly ExpectedUsageEvidence[] {
  return [{ status: "expected", componentRole: "speech_to_text", key: transcriptionKey(itemId) }];
}

/**
 * The item's transcription settles its usage: once per content part when it completed, with
 * its usage, and with unknown usage when it failed.
 */
export function settledTranscriptionUsage(
  itemId: string,
  outcome:
    | Readonly<{
        kind: "completed";
        contentIndex: number | undefined;
        usage: RuntimeUsageNormalization;
      }>
    | Readonly<{ kind: "failed" }>,
): readonly ConversationUsageEvidence[] {
  const pendingKey = transcriptionKey(itemId);
  return outcome.kind === "completed"
    ? [
        settled(
          {
            componentRole: "speech_to_text",
            key: `${pendingKey}:${outcome.contentIndex ?? "unknown"}`,
            pendingKey,
          },
          outcome.usage,
        ),
      ]
    : [
        {
          status: "unavailable",
          componentRole: "speech_to_text",
          key: `${pendingKey}:failed`,
          pendingKey,
        },
      ];
}

function responseKey(responseId: string): string {
  return `speech_to_speech:${responseId}`;
}

function transcriptionKey(itemId: string): string {
  return `speech_to_text:${itemId}`;
}

function settled(
  identity: Readonly<{ componentRole: string; key: string; pendingKey?: string }>,
  usage: RuntimeUsageNormalization,
): ConversationUsageEvidence {
  return usage.status === "valid"
    ? { ...identity, status: "satisfied", measurements: usage.observations }
    : { ...identity, status: "unavailable" };
}
