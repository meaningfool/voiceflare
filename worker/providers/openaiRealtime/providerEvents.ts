import { z } from "zod";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import type { ConversationToolInvocation } from "../../runtime/implementationContracts.ts";
import {
  expectedResponseUsage,
  expectedTranscriptionUsage,
  normalizeRealtimeUsage,
  normalizeTranscriptionUsage,
  settledResponseUsage,
  settledTranscriptionUsage,
  type RealtimeUsageModels,
} from "./usage.ts";
import type { ConversationUsageEvidence } from "../../runtime/runtimeUsage.ts";
import { compactRealtimeEventPayload } from "./providerRuntimeEvents.ts";
import type { ProviderResponseTerminalStatus } from "../../runtime/interviewFinalizationModel.ts";
import type { RealtimeObservation } from "./speech.ts";

export type ParsedProviderEvent =
  | string
  | number
  | boolean
  | null
  | ParsedProviderEvent[]
  | ProviderEventRecord;

export interface ProviderEventRecord {
  readonly [key: string]: ParsedProviderEvent;
}

const providerJsonSchema = z.custom<ParsedProviderEvent>(
  (value): value is ParsedProviderEvent =>
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    (typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)),
);
const binaryProviderMessageSchema = z
  .object({
    byteLength: z.unknown().optional(),
    size: z.unknown().optional(),
  })
  .catch({});

type ProviderIngressData =
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "binary"; byteLength: number | null }>;

const providerIngressSchema = z.unknown().transform((data): ProviderIngressData => {
  if (typeof data === "string") return { kind: "text", value: data };
  const binaryMessage = binaryProviderMessageSchema.parse(data);
  const byteLength = binaryMessage.byteLength ?? binaryMessage.size;
  return {
    kind: "binary",
    byteLength: typeof byteLength === "number" ? byteLength : null,
  };
});

export interface ProviderEventSummary {
  [key: string]: ParsedProviderEvent | ProviderErrorSummary | undefined;
  sequence?: number;
  type?: string;
  event_id?: string;
  session_id?: string;
  conversation_id?: string;
  item_id?: string;
  response_id?: string;
  status?: string;
  transcript?: string;
  usage?: ParsedProviderEvent;
  error?: ProviderErrorSummary;
}

interface ProviderErrorSummary {
  [key: string]: string | undefined;
  type?: string;
  code?: string;
  message?: string;
  param?: string;
  event_id?: string;
}

interface ProviderObservationOrderDraft {
  generation: number;
  sequence: number;
  providerEventId?: string;
  observedAt?: number;
  toolInvocations?: readonly ConversationToolInvocation[];
  usage?: readonly ConversationUsageEvidence[];
}

interface ProviderTranscriptItemObservationDraft extends ProviderObservationOrderDraft {
  kind: "transcript_item_observed";
  nonTranscript?: boolean;
  itemId: string;
  previousItemId?: string;
  role?: ProviderTranscriptRole;
  responseId?: string;
  outputIndex?: number;
}

interface ProviderInputTranscriptionCompletedDraft extends ProviderObservationOrderDraft {
  kind: "participant_answer_transcribed";
  itemId: string;
  contentIndex?: number;
  text?: string;
}

interface ProviderInputTranscriptionFailedDraft extends ProviderObservationOrderDraft {
  kind: "participant_answer_transcription_failed";
  itemId: string;
  code?: string;
}

interface ProviderAssistantTranscriptFinalizedDraft extends ProviderObservationOrderDraft {
  kind: "agent_transcript_finalized";
  itemId: string;
  responseId?: string;
  text?: string;
}

interface ProviderResponseDoneDraft extends ProviderObservationOrderDraft {
  kind: "reply_generated" | "reply_cancelled";
  responseId: string;
  status?: Exclude<ProviderResponseTerminalStatus, "cancelled">;
  transcriptItems?: ReturnType<typeof readResponseTranscriptItems>;
  transcriptInventoryComplete?: boolean;
}

interface ProviderOutputAudioDraft extends ProviderObservationOrderDraft {
  kind: "reply_delivery_started" | "reply_delivery_stopped";
  responseId?: string;
}

interface ProviderErrorObservationDraft extends ProviderObservationOrderDraft {
  kind: "session_error_observed";
  eventId?: string;
  code?: string;
}

export type ProviderTranscriptRole = "participant" | "conversationAgent";

export type ProviderEventError = Readonly<{
  message: string;
  code?: string;
  reportAsDegradation: boolean;
}>;

export type NormalizedProviderEvent = Readonly<{
  type: string;
  diagnosticSummary: ProviderEventSummary;
  runtimeEventPayload: Record<string, unknown>;
  toolInvocations: readonly ConversationToolInvocation[];
  error: ProviderEventError | null;
}>;

export const parseRealtimeEvent = boundary({
  schema: providerIngressSchema,
  convert: (data): ParsedProviderEvent => {
    if (data.kind === "binary") {
      return {
        type: "binary_message",
        byteLength: data.byteLength,
      };
    }

    return decodeProviderText(data.value);
  },
});

/**
 * One provider message reaches several kit decoders: the pair's receipt decoder, the Runtime
 * observation and the event normalization. Its text is decoded once, and the parsed
 * value is shared by those decoders, which only read it.
 */
let lastDecodedText: Readonly<{ text: string; event: ParsedProviderEvent }> | null = null;
function decodeProviderText(text: string): ParsedProviderEvent {
  if (lastDecodedText?.text === text) return lastDecodedText.event;
  let event: ParsedProviderEvent;
  try {
    const parsed: unknown = JSON.parse(text);
    event = providerJsonSchema.parse(parsed);
  } catch {
    event = { type: "unparseable_text", preview: text.slice(0, 200) };
  }
  lastDecodedText = { text, event };
  return event;
}

export const normalizeProviderRealtimeEvent = boundary({
  schema: providerIngressSchema,
  convert: (data): NormalizedProviderEvent => {
    const event =
      data.kind === "text"
        ? parseRealtimeEvent(data.value)
        : ({ type: "binary_message", byteLength: data.byteLength } satisfies ParsedProviderEvent);
    const value = asRecord(event);
    const type = asOptionalString(value?.type) ?? "unknown";
    const error = asRecord(value?.error);
    const errorCode = asOptionalString(error?.code);

    let normalizedError: ProviderEventError | null = null;
    if (type === "error") {
      const message =
        asOptionalString(error?.message) ??
        asOptionalString(value?.message) ??
        "OpenAI sideband provider error observed.";
      // Nothing to settle and nothing to cancel are answers to Ending's steps, not faults.
      const reportAsDegradation =
        errorCode !== "input_audio_buffer_commit_empty" &&
        errorCode !== "response_cancel_not_active";
      normalizedError =
        errorCode === undefined
          ? { message, reportAsDegradation }
          : { message, code: errorCode, reportAsDegradation };
    }
    return {
      type,
      diagnosticSummary: summarizeRealtimeEventWithoutSequence(event),
      runtimeEventPayload: compactRealtimeEventPayload(event, type),
      toolInvocations:
        type === "response.done" || type === "response.function_call_arguments.done"
          ? getProviderToolInvocations(event)
          : [],
      error: normalizedError,
    };
  },
});

/** What identifies one received sideband message, independently of its interpretation. */
type ProviderMessageReceiptFields = {
  type: string;
  event_id?: string;
  item_id?: string;
  response_id?: string;
  byteLength?: number;
};
export type ProviderMessageReceipt = Readonly<ProviderMessageReceiptFields>;

/**
 * Identifies one sideband message as the socket received it, before any normalization or
 * Runtime processing, so the raw provider stream stays provable on its own. It never throws.
 */
export function summarizeProviderMessageReceipt(
  data: Parameters<typeof parseRealtimeEvent>[0],
): ProviderMessageReceipt {
  try {
    const value = asRecord(parseRealtimeEvent(data));
    const eventId = asOptionalIdentifier(value?.event_id);
    const itemId =
      asOptionalIdentifier(value?.item_id) ?? asOptionalIdentifier(asRecord(value?.item)?.id);
    const responseId =
      asOptionalIdentifier(value?.response_id) ??
      asOptionalIdentifier(asRecord(value?.response)?.id);
    const byteLength = asOptionalNumber(value?.byteLength);
    const receipt: ProviderMessageReceiptFields = {
      type: asOptionalString(value?.type) ?? "unknown",
    };
    if (eventId !== undefined) receipt.event_id = eventId;
    if (itemId !== undefined) receipt.item_id = itemId;
    if (responseId !== undefined) receipt.response_id = responseId;
    if (byteLength !== undefined) receipt.byteLength = byteLength;
    return receipt;
  } catch {
    return { type: "unreadable_message" } satisfies ProviderMessageReceipt;
  }
}

/**
 * Converts provider facts into the Runtime observation vocabulary. Lifecycle
 * admission remains in interviewFinalizationFSM.ts; this function only understands
 * provider event shapes and intentionally has no stateful decisions.
 */
export function normalizeProviderRuntimeObservation(
  data: Parameters<typeof parseRealtimeEvent>[0],
  sequence: number,
  observeAllProviderEvents = false,
  observedAt?: number,
  /** The models the session's settings name; without them, usage is reported invalid. */
  usageModels?: RealtimeUsageModels,
): RealtimeObservation | null {
  const event = parseRealtimeEvent(data);
  const value = asRecord(event);
  const type = asOptionalString(value?.type);
  const providerEventId = asOptionalIdentifier(value?.event_id);
  const order: ProviderObservationOrderDraft = {
    generation: 1,
    sequence,
  };
  if (observedAt !== undefined) order.observedAt = observedAt;
  if (providerEventId !== undefined) order.providerEventId = providerEventId;
  const response = asRecord(value?.response);
  const responseId = asOptionalIdentifier(value?.response_id) ?? asOptionalIdentifier(response?.id);
  const item = asRecord(value?.item);
  const itemId = asOptionalIdentifier(value?.item_id) ?? asOptionalIdentifier(item?.id);
  const at = observedAt ?? Date.now();

  if (
    (type === "conversation.item.added" || type === "conversation.item.done") &&
    itemId !== undefined
  ) {
    const role = mapProviderRole(item?.role);
    const previousItemId =
      asOptionalString(value?.previous_item_id) ?? asOptionalString(item?.previous_item_id);
    const observation: ProviderTranscriptItemObservationDraft = {
      ...order,
      kind: "transcript_item_observed",
      itemId,
    };
    if (item?.type === "function_call" || item?.type === "function_call_output")
      observation.nonTranscript = true;
    if (previousItemId !== undefined) observation.previousItemId = previousItemId;
    if (role !== undefined) observation.role = role;
    return observation;
  }

  if (type === "input_audio_buffer.committed" && itemId !== undefined) {
    return {
      ...order,
      kind: "participant_answer_created",
      itemId,
      usage: expectedTranscriptionUsage(itemId),
    };
  }

  if (
    (type === "response.output_item.added" || type === "response.output_item.done") &&
    itemId !== undefined
  ) {
    const role = mapProviderRole(item?.role) ?? "conversationAgent";
    const outputIndex = asOptionalNumber(value?.output_index);
    const observation: ProviderTranscriptItemObservationDraft = {
      ...order,
      kind: "transcript_item_observed",
      itemId,
      role,
    };
    if (item?.type === "function_call" || item?.type === "function_call_output")
      observation.nonTranscript = true;
    if (responseId !== undefined) observation.responseId = responseId;
    if (outputIndex !== undefined) observation.outputIndex = outputIndex;
    return observation;
  }

  if (type === "input_audio_buffer.speech_started") {
    return { ...order, kind: "speech_started", at };
  }

  if (type === "input_audio_buffer.speech_stopped") {
    return { ...order, kind: "speech_stopped", at };
  }

  if (type === "input_audio_buffer.committed" && itemId !== undefined) {
    return {
      ...order,
      kind: "participant_answer_created",
      itemId,
      usage: expectedTranscriptionUsage(itemId),
    };
  }

  if (type === "conversation.item.input_audio_transcription.completed" && itemId !== undefined) {
    const text = asFinalTranscript(value?.transcript);
    const contentIndex = asOptionalNumber(value?.content_index);
    const observation: ProviderInputTranscriptionCompletedDraft = {
      ...order,
      kind: "participant_answer_transcribed",
      itemId,
      usage: settledTranscriptionUsage(itemId, {
        kind: "completed",
        contentIndex,
        usage: normalizeTranscriptionUsage(value?.usage, usageModels),
      }),
    };
    if (contentIndex !== undefined) observation.contentIndex = contentIndex;
    if (text !== undefined) observation.text = text;
    return observation;
  }

  if (type === "conversation.item.input_audio_transcription.failed" && itemId !== undefined) {
    const error = asRecord(value?.error);
    const code = asOptionalString(error?.code) ?? asOptionalString(value?.code);
    const observation: ProviderInputTranscriptionFailedDraft = {
      ...order,
      kind: "participant_answer_transcription_failed",
      itemId,
      usage: settledTranscriptionUsage(itemId, { kind: "failed" }),
    };
    if (code !== undefined) observation.code = code;
    return observation;
  }

  if (
    (type === "response.output_audio_transcript.done" ||
      (observeAllProviderEvents && type === "response.output_text.done")) &&
    itemId !== undefined
  ) {
    const text = asFinalTranscript(
      type === "response.output_text.done" ? value?.text : value?.transcript,
    );
    const observation: ProviderAssistantTranscriptFinalizedDraft = {
      ...order,
      kind: "agent_transcript_finalized",
      itemId,
    };
    if (responseId !== undefined) observation.responseId = responseId;
    if (text !== undefined) observation.text = text;
    return observation;
  }

  if (type === "response.created" && responseId !== undefined) {
    return {
      ...order,
      kind: "reply_started",
      responseId,
      usage: expectedResponseUsage(responseId),
    };
  }

  const toolInvocations =
    type === "response.done" || type === "response.function_call_arguments.done"
      ? getProviderToolInvocations(event)
      : [];
  if (toolInvocations.length > 0) order.toolInvocations = toolInvocations;
  if (
    type === "response.function_call_arguments.done" ||
    (type === "response.done" && responseId === undefined)
  ) {
    if (toolInvocations.length > 0) return { ...order, kind: "session_activity_observed", at };
  }

  if (type === "response.done" && responseId !== undefined) {
    const status = asOptionalString(response?.status) ?? asOptionalString(value?.status);
    const terminalStatus = asProviderResponseTerminalStatus(status);
    const transcriptItems = readResponseTranscriptItems(
      response,
      responseId,
      observeAllProviderEvents && terminalStatus === "completed",
    );
    const observation: ProviderResponseDoneDraft = {
      ...order,
      kind: terminalStatus === "cancelled" ? "reply_cancelled" : "reply_generated",
      responseId,
      usage: settledResponseUsage(responseId, normalizeRealtimeUsage(response?.usage, usageModels)),
    };
    if (terminalStatus !== undefined && terminalStatus !== "cancelled")
      observation.status = terminalStatus;
    if (transcriptItems.length > 0) observation.transcriptItems = transcriptItems;
    if (hasConclusiveResponseInventory(response)) observation.transcriptInventoryComplete = true;
    return observation;
  }

  if (type === "output_audio_buffer.started") {
    const observation: ProviderOutputAudioDraft = {
      ...order,
      kind: "reply_delivery_started",
    };
    if (responseId !== undefined) observation.responseId = responseId;
    return observation;
  }

  if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
    const observation: ProviderOutputAudioDraft = {
      ...order,
      kind: "reply_delivery_stopped",
    };
    if (responseId !== undefined) observation.responseId = responseId;
    return observation;
  }

  if (type === "error") {
    const error = asRecord(value?.error);
    const eventId = asOptionalString(error?.event_id);
    const code = asOptionalString(error?.code);
    // An input closure's commit that found the buffer empty had nothing to settle.
    if (code === "input_audio_buffer_commit_empty" && eventId !== undefined)
      return { ...order, kind: "nothing_to_settle", commandId: eventId };
    // A cancel that found its reply already finished had nothing to cancel.
    if (code === "response_cancel_not_active" && eventId !== undefined)
      return { ...order, kind: "nothing_to_cancel", commandId: eventId };
    const observation: ProviderErrorObservationDraft = {
      ...order,
      kind: "session_error_observed",
    };
    if (eventId !== undefined) observation.eventId = eventId;
    if (code !== undefined) observation.code = code;
    return observation;
  }

  if (type === "session.closed" || type === "realtime.session.closed") {
    return { ...order, kind: "session_closed_observed", at };
  }

  if (
    !observeAllProviderEvents ||
    type === undefined ||
    type.length === 0 ||
    type === "unparseable_text" ||
    type === "binary_message"
  ) {
    return null;
  }
  const activity = { ...order, kind: "session_activity_observed" as const, at };
  // A response or transcription Realtime cannot attribute may have used what it does not report.
  return type === "response.done" ||
    type === "conversation.item.input_audio_transcription.completed"
    ? { ...activity, usage: [{ status: "uncertain" }] }
    : activity;
}

type ResponseTranscriptItem = {
  itemId: string;
  role: ProviderTranscriptRole;
  responseId: string;
  outputIndex: number;
  nonTranscript?: boolean;
  text?: string;
};
function readResponseTranscriptItems(
  response: ProviderEventRecord | undefined,
  responseId: string,
  captureFinalText: boolean,
): ResponseTranscriptItem[] {
  return Array.isArray(response?.output)
    ? response.output.flatMap((candidate, outputIndex) => {
        const output = asRecord(candidate);
        const outputItemId = asOptionalIdentifier(output?.id);
        if (outputItemId === undefined) return [];
        const item: ResponseTranscriptItem = {
          itemId: outputItemId,
          role: mapProviderRole(output?.role) ?? "conversationAgent",
          responseId,
          outputIndex,
        };
        if (
          output?.type === "function_call" ||
          output?.type === "function_call_output" ||
          (output?.type === "message" &&
            Array.isArray(output.content) &&
            output.content.length === 0)
        ) {
          item.nonTranscript = true;
        }
        // A session that observes every provider event takes final text from the terminal
        // inventory; otherwise the dedicated audio-transcript events remain its capture.
        if (captureFinalText) {
          const text = readFinalResponseItemText(output);
          if (text !== undefined) item.text = text;
        }
        return [item];
      })
    : [];
}

function readFinalResponseItemText(item: ProviderEventRecord | undefined): string | undefined {
  if (
    item?.type !== "message" ||
    item.role !== "assistant" ||
    !Array.isArray(item.content) ||
    item.content.length === 0
  )
    return undefined;
  const parts: string[] = [];
  for (const part of item.content) {
    const content = asRecord(part);
    const text =
      content?.type === "text" || content?.type === "output_text"
        ? asFinalTranscript(content.text)
        : content?.type === "audio" || content?.type === "output_audio"
          ? asFinalTranscript(content.transcript)
          : undefined;
    if (text === undefined) return undefined;
    parts.push(text);
  }
  return parts.join("\n");
}

/** Only a complete terminal output inventory can prove that no message was omitted. */
function hasConclusiveResponseInventory(response: ProviderEventRecord | undefined): boolean {
  const itemIds = new Set<string>();
  return (
    Array.isArray(response?.output) &&
    response.output.every((candidate) => {
      const item = asRecord(candidate);
      const itemId = asOptionalIdentifier(item?.id);
      if (itemId === undefined || itemIds.has(itemId)) return false;
      itemIds.add(itemId);
      if (item?.type === "function_call" || item?.type === "function_call_output") return true;
      return (
        item?.type === "message" &&
        item.role === "assistant" &&
        Array.isArray(item.content) &&
        item.content.every((part) => {
          const content = asRecord(part);
          return (
            content?.type === "audio" ||
            content?.type === "text" ||
            content?.type === "output_audio" ||
            content?.type === "output_text"
          );
        })
      );
    })
  );
}

function asProviderResponseTerminalStatus(
  value: string | undefined,
): ProviderResponseTerminalStatus | undefined {
  switch (value) {
    case "completed":
    case "cancelled":
    case "failed":
    case "incomplete":
      return value;
    default:
      return undefined;
  }
}

function summarizeRealtimeEventWithoutSequence(event: ParsedProviderEvent): ProviderEventSummary {
  const value = asRecord(event);
  const response = asRecord(value?.response);
  const responseOutput = Array.isArray(response?.output) ? response.output : [];
  const firstOutput = asRecord(responseOutput[0]);
  const session = asRecord(value?.session);
  const error = asRecord(value?.error);

  const summary: ProviderEventSummary = {};
  const type = asOptionalString(value?.type);
  const eventId = asOptionalString(value?.event_id);
  const sessionId = asOptionalString(session?.id);
  const conversationId = asOptionalString(response?.conversation_id ?? value?.conversation_id);
  const itemId =
    asOptionalString(value?.item_id) ??
    asOptionalString(asRecord(value?.item)?.id) ??
    asOptionalString(firstOutput?.id);
  const responseId = asOptionalString(value?.response_id) ?? asOptionalString(response?.id);
  const status = asOptionalString(response?.status) ?? asOptionalString(value?.status);
  const transcript = asOptionalString(value?.transcript);
  if (type !== undefined) summary.type = type;
  if (eventId !== undefined) summary.event_id = eventId;
  if (sessionId !== undefined) summary.session_id = sessionId;
  if (conversationId !== undefined) summary.conversation_id = conversationId;
  if (itemId !== undefined) summary.item_id = itemId;
  if (responseId !== undefined) summary.response_id = responseId;
  if (status !== undefined) summary.status = status;
  if (transcript !== undefined) summary.transcript = transcript;
  if (response?.usage !== undefined) summary.usage = response.usage;
  if (error !== undefined) summary.error = compactProviderError(error);
  return summary;
}

/** Decode function-call facts in original order; authoritative observations admit terminal forms. */
export function getProviderToolInvocations(
  event: ParsedProviderEvent,
): readonly ConversationToolInvocation[] {
  const envelope = asRecord(event);
  const type = asOptionalString(envelope?.type);
  const response = asRecord(envelope?.response);
  const responseId =
    asOptionalIdentifier(envelope?.response_id) ??
    asOptionalIdentifier(envelope?.responseId) ??
    asOptionalIdentifier(response?.id);
  const invocations: ConversationToolInvocation[] = [];
  collectToolInvocations(event, responseId, type, invocations);
  return invocations;
}

function collectToolInvocations(
  value: ParsedProviderEvent,
  responseId: string | undefined,
  type: string | undefined,
  invocations: ConversationToolInvocation[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolInvocations(item, responseId, type, invocations);
    return;
  }
  const record = asRecord(value);
  if (record === undefined) return;
  if (
    (record.type === "function_call" || record.type === "response.function_call_arguments.done") &&
    typeof record.name === "string"
  ) {
    const callId = asOptionalIdentifier(record.call_id) ?? asOptionalIdentifier(record.callId);
    const itemId =
      asOptionalString(record.item_id) ??
      asOptionalString(record.itemId) ??
      asOptionalString(record.id);
    const outputId =
      responseId ??
      asOptionalIdentifier(record.response_id) ??
      asOptionalIdentifier(record.responseId);
    const invocation: MutableConversationToolInvocation = { toolName: record.name };
    if (type !== undefined) invocation.type = type;
    if (callId !== undefined) invocation.callId = callId;
    if (itemId !== undefined) invocation.itemId = itemId;
    if (outputId !== undefined) invocation.responseId = outputId;
    if (Object.hasOwn(record, "arguments")) invocation.arguments = record.arguments;
    invocations.push(invocation);
    return;
  }
  for (const item of Object.values(record))
    collectToolInvocations(item, responseId, type, invocations);
}

function compactProviderError(value: ProviderEventRecord): ProviderErrorSummary {
  const summary: ProviderErrorSummary = {};
  const type = asOptionalString(value.type);
  const code = asOptionalString(value.code);
  const message = asOptionalString(value.message);
  const param = asOptionalString(value.param);
  const eventId = asOptionalString(value.event_id);
  if (type !== undefined) summary.type = type;
  if (code !== undefined) summary.code = code;
  if (message !== undefined) summary.message = message;
  if (param !== undefined) summary.param = param;
  if (eventId !== undefined) summary.event_id = eventId;
  return summary;
}

function mapProviderRole(
  value: ParsedProviderEvent | undefined,
): ProviderTranscriptRole | undefined {
  if (value === "user") {
    return "participant";
  }

  if (value === "assistant") {
    return "conversationAgent";
  }

  return undefined;
}

function asFinalTranscript(value: ParsedProviderEvent | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim().length > 0 ? value : undefined;
}

function asOptionalString(value: ParsedProviderEvent | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalIdentifier(value: ParsedProviderEvent | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function asOptionalNumber(value: ParsedProviderEvent | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: ParsedProviderEvent | undefined): ProviderEventRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: ParsedProviderEvent | undefined): value is ProviderEventRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type MutableConversationToolInvocation = {
  -readonly [Key in keyof ConversationToolInvocation]: ConversationToolInvocation[Key];
};
