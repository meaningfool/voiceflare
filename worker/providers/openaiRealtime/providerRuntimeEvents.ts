import { summarizeProviderRealtimeSessionEvent } from "./preparedModelSession.ts";
import type { ParsedProviderEvent, ProviderEventRecord } from "./providerEvents.ts";

const maxStringLength = 500;
const maxArrayItems = 8;

type RuntimeDiagnosticValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | RuntimeDiagnosticValue[]
  | RuntimeDiagnosticData;

type RuntimeDiagnosticData = { [key: string]: RuntimeDiagnosticValue };

export function compactRealtimeEventPayload(
  event: ParsedProviderEvent,
  type = asOptionalString(asRecord(event)?.type),
): Record<string, unknown> {
  const value = asRecord(event);
  const item = compactProviderItem(value?.item);
  const response = compactProviderResponse(value?.response, type === "response.done");
  const session = summarizeProviderRealtimeSessionEvent(event) ?? undefined;
  const statusDetails = compactStatusDetails(value?.status_details);

  const redacted = redactSecrets({
    eventId: asOptionalString(value?.event_id),
    providerEventType: asOptionalString(type) ?? "unknown",
    source: "provider",
    provider: "openai_realtime",
    itemId: asOptionalString(value?.item_id ?? item?.id),
    responseId: asOptionalString(value?.response_id ?? response?.id),
    previousItemId: asOptionalString(value?.previous_item_id),
    outputIndex: asOptionalNumber(value?.output_index),
    contentIndex: asOptionalNumber(value?.content_index),
    audioEndMs: asOptionalNumber(value?.audio_end_ms),
    status: asOptionalString(value?.status),
    statusDetails,
    item,
    response,
    session,
    error: compactProviderError(value?.error),
  });

  return isRecord(redacted) ? withoutUndefined(redacted) : {};
}

function compactProviderResponse(
  value: ParsedProviderEvent | undefined,
  includeOutputUsage: boolean,
): RuntimeDiagnosticData | undefined {
  const record = asRecord(value);

  if (record === undefined) {
    return undefined;
  }

  const output = Array.isArray(record.output)
    ? record.output.slice(0, maxArrayItems).map(compactProviderItem).filter(isRecord)
    : undefined;
  const reportedOutputTokens = asRecord(record.usage)?.output_tokens;
  const outputTokens =
    includeOutputUsage &&
    typeof reportedOutputTokens === "number" &&
    Number.isSafeInteger(reportedOutputTokens) &&
    reportedOutputTokens >= 0
      ? reportedOutputTokens
      : undefined;

  return withoutUndefined({
    id: asOptionalString(record.id),
    status: asOptionalString(record.status),
    statusDetails: compactStatusDetails(record.status_details),
    output: output === undefined || output.length === 0 ? undefined : output,
    outputTokens,
  });
}

function compactProviderItem(
  value: ParsedProviderEvent | undefined,
): RuntimeDiagnosticData | undefined {
  const record = asRecord(value);

  if (record === undefined) {
    return undefined;
  }

  return withoutUndefined({
    id: asOptionalString(record.id),
    type: asOptionalString(record.type),
    role: asOptionalString(record.role),
    status: asOptionalString(record.status),
  });
}

function compactProviderError(
  value: ParsedProviderEvent | undefined,
): RuntimeDiagnosticData | undefined {
  const record = asRecord(value);

  if (record === undefined) {
    return undefined;
  }

  const redacted = redactSecrets({
    type: asOptionalString(record.type),
    code: asOptionalString(record.code),
    message: boundedString(record.message),
    param: asOptionalString(record.param),
    eventId: asOptionalString(record.event_id),
  });

  return isRecord(redacted) ? withoutUndefined(redacted) : {};
}

function compactStatusDetails(
  value: ParsedProviderEvent | undefined,
): RuntimeDiagnosticData | undefined {
  const record = asRecord(value);

  if (record === undefined) {
    return undefined;
  }

  return withoutUndefined({
    type: asOptionalString(record.type),
    reason: asOptionalString(record.reason),
  });
}

function boundedString<Value>(value: Value): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length > maxStringLength
    ? `${normalized.slice(0, maxStringLength - 3)}...`
    : normalized;
}

function asOptionalString<Value>(value: Value): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalNumber<Value>(value: Value): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: ParsedProviderEvent | undefined): ProviderEventRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: RuntimeDiagnosticValue): value is RuntimeDiagnosticData;
function isRecord(value: ParsedProviderEvent | undefined): value is ProviderEventRecord;
function isRecord(
  value: RuntimeDiagnosticValue | ParsedProviderEvent,
): value is RuntimeDiagnosticData | ProviderEventRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactSecrets<Value>(value: Value): RuntimeDiagnosticValue {
  if (typeof value === "string") {
    return value
      .replace(/sk-[A-Za-z0-9_-]+/g, "sk-redacted")
      .replace(/ek_[A-Za-z0-9_-]+/g, "ek_redacted");
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]),
    );
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value === null) return null;

  return undefined;
}

function withoutUndefined<Value extends RuntimeDiagnosticData>(value: Value) {
  const result: RuntimeDiagnosticData = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item !== undefined) result[key] = item;
  }
  return result;
}
