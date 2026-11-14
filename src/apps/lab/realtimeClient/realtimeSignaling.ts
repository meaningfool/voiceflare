import {
  originalRealtimeSelection,
  type ConversationSelection,
} from "../../../../worker/shared/contracts/conversationSelection.ts";
import type { LabInterviewInput } from "../data/conversationPresets";
import type { InterviewPromptProvenance } from "../data/interviewPrompt";
import type { LabRealtimeSettings } from "./labRealtimeSettings";
import type { LabReasoningEffort, LabInterviewRunIdentity } from "../interviewClient";
import { z } from "zod";
import { boundary } from "../../../../tools/boundary-contracts/boundary-contracts.mjs";

export type RealtimeCallSignal = {
  runIdentity: LabInterviewRunIdentity;
  answerSdp: string;
  sessionId: string;
  sessionLocation: string | null;
  upstreamRequestId: string | null;
};

export type RealtimeHangupResult = {
  ok: boolean;
  status: number | null;
  debugText: string;
  code?: string | null;
  completion?: {
    endedAt?: number;
    endReason?: string;
    completionReviewStatus?: "clean" | "warning";
    completionStatus?: string;
    completionDebugText?: string;
    transcriptTurnCount?: number;
  } | null;
};

export type RuntimePresenceResult = {
  ok: boolean;
  status: number | null;
  code?: string | null;
};

// This browser owns the current native negotiation format; the Lab Worker relays it.
const realtimeBrowserAnswerSchema = z.object({ sdp: z.string().min(1) });
const realtimeBrowserDiagnosticsSchema = z.object({
  sessionId: z.string().min(1),
  sessionLocation: z.string().nullable().optional(),
  upstreamRequestId: z.string().nullable().optional(),
});
const realtimeConnectionReplySchema = z.object({
  runId: z.string().min(1),
  exchangeId: z.string().min(1),
  acceptance: z.literal("accepted"),
  reply: realtimeBrowserAnswerSchema,
  diagnostics: realtimeBrowserDiagnosticsSchema,
});
const realtimeConnectionOwnFieldsSchema = z.unknown().superRefine((value, context) => {
  if (!isConnectionReplyRecord(value)) return;
  for (const [source, fields, path] of [
    [value, realtimeConnectionReplySchema.keyof().options, []],
    [value.reply, realtimeBrowserAnswerSchema.keyof().options, ["reply"]],
    [value.diagnostics, realtimeBrowserDiagnosticsSchema.keyof().options, ["diagnostics"]],
  ] as const) {
    if (!isConnectionReplyRecord(source)) continue;
    for (const field of fields) {
      if (field in source && !Object.hasOwn(source, field)) {
        context.addIssue({
          code: "custom",
          path: [...path, field],
          message: "must be an own property",
        });
      }
    }
  }
});
export const decodeRealtimeConnectionReply = boundary({
  schema: realtimeConnectionOwnFieldsSchema.pipe(realtimeConnectionReplySchema),
  convert: (value) => value,
});

function isConnectionReplyRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const runtimeCompletionSchema = z.object({
  endedAt: z.number().optional().catch(undefined),
  endReason: z.string().optional().catch(undefined),
  completionReviewStatus: z
    .union([z.literal("clean"), z.literal("warning")])
    .optional()
    .catch(undefined),
  completionStatus: z.string().optional().catch(undefined),
  completionDebugText: z.string().optional().catch(undefined),
  transcriptTurnCount: z.number().optional().catch(undefined),
  warnings: z.array(z.string().nullable().catch(null)).optional().catch(undefined),
  transcriptSnapshot: z
    .object({ turnCount: z.number().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});
const runtimeCompletionEnvelopeSchema = z.object({
  completion: runtimeCompletionSchema.nullable().optional().catch(null),
});
const labRunIdentitySchema = z.object({
  runId: z.string().min(1),
  startedAt: z.number().int().finite(),
});

export const RUNTIME_WORKER_UNAVAILABLE_MESSAGE =
  "Runtime Worker is not connected through RUNTIME_WORKER. Start the Runtime Worker first, restart the Lab Worker, then verify /_api/runtime/health returns ok.";

export class RealtimeCallError extends Error {
  readonly code: string | null;
  readonly reason: string | null;
  readonly runIdentity: LabInterviewRunIdentity | null;

  constructor(
    message: string,
    options: {
      code?: string | null;
      reason?: string | null;
      runIdentity?: LabInterviewRunIdentity | null;
    } = {},
  ) {
    super(message);
    this.name = "RealtimeCallError";
    this.code = options.code ?? null;
    this.reason = options.reason ?? null;
    const runIdentity = labRunIdentitySchema.safeParse(options.runIdentity);
    this.runIdentity = runIdentity.success ? runIdentity.data : null;
  }
}

export type SignalRealtimeCallOptions = {
  attemptId?: string;
  exchangeId?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
  onRunAllocated?: (identity: LabInterviewRunIdentity) => void;
  endpointBaseUrl: string;
  offerSdp: string;
  /** The selected Conversation's interview input, built by its Lab builder. */
  agentInput: LabInterviewInput;
  selection?: ConversationSelection | undefined;
  reasoningEffort?: LabReasoningEffort | null;
  promptProvenance?: InterviewPromptProvenance | null;
  executionSettings?: LabRealtimeSettings | undefined;
  fetchImpl?: typeof fetch;
};

type RealtimeCallJsonPayload = {
  attemptId?: string;
  profile: string;
  connection: { exchangeId: string; input: { sdp: string } };
  selection: ConversationSelection;
  agentInput: LabInterviewInput;
  reasoningEffort?: LabReasoningEffort;
  promptProvenance?: InterviewPromptProvenance;
  executionSettings?: LabRealtimeSettings;
};

export const LAB_RUN_ID_HEADER = "X-Lab-Run-Id";
export const LAB_RUN_STARTED_AT_HEADER = "X-Lab-Run-Started-At";

export function buildRealtimeCallUrl(endpointBaseUrl: string): string {
  if (endpointBaseUrl.length === 0) {
    throw new Error("Set VITE_LAB_WORKER_URL before starting a live Interview.");
  }

  const url = new URL("/_api/runtime/runs", endpointBaseUrl);
  return url.toString();
}

export function buildRuntimeEventsUrl(
  endpointBaseUrl: string,
  runId: string,
  sessionId: string,
  durationMs: number,
): string {
  if (endpointBaseUrl.length === 0) {
    throw new Error("Set VITE_LAB_WORKER_URL before opening sideband control.");
  }

  if (!Number.isFinite(durationMs) || !Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error("Realtime sideband duration must be a positive finite integer.");
  }

  const url = new URL("/_api/runtime/events", endpointBaseUrl);
  url.searchParams.set("runId", runId);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("durationMs", String(durationMs));
  return url.toString();
}

export function buildRuntimeCloseUrl(endpointBaseUrl: string, runId: string): string {
  if (endpointBaseUrl.length === 0) {
    throw new Error("Set VITE_LAB_WORKER_URL before ending a live Interview.");
  }

  const url = new URL(`/_api/runtime/runs/${encodeURIComponent(runId)}/complete`, endpointBaseUrl);
  return url.toString();
}

export function buildRuntimePresenceUrl(endpointBaseUrl: string, runId: string): string {
  if (endpointBaseUrl.length === 0) {
    throw new Error("Set VITE_LAB_WORKER_URL before sending runtime presence.");
  }

  const url = new URL("/_api/runtime/presence", endpointBaseUrl);
  url.searchParams.set("runId", runId);
  return url.toString();
}

export function getProviderCallId(sessionLocation: string | null): string | null {
  if (sessionLocation === null) {
    return null;
  }

  const locationPath = sessionLocation.split("?")[0] ?? "";
  const candidate = locationPath.split("/").filter(Boolean).at(-1) ?? "";
  return /^rtc_[A-Za-z0-9_-]+$/.test(candidate) ? candidate : null;
}

export async function signalRealtimeCall({
  endpointBaseUrl,
  offerSdp,
  attemptId,
  exchangeId = crypto.randomUUID(),
  deadlineAt,
  signal,
  onRunAllocated,
  agentInput,
  selection = originalRealtimeSelection,
  reasoningEffort = null,
  promptProvenance = null,
  executionSettings,
  fetchImpl = fetch,
}: SignalRealtimeCallOptions): Promise<RealtimeCallSignal> {
  signal?.throwIfAborted();
  if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
    throw new DOMException("Lab startup deadline expired.", "TimeoutError");
  }
  const jsonPayload: RealtimeCallJsonPayload = {
    selection,
    agentInput,
    profile: "realtime-v1",
    connection: { exchangeId, input: { sdp: offerSdp } },
  };
  if (attemptId !== undefined) jsonPayload.attemptId = attemptId;
  if (reasoningEffort !== null) jsonPayload.reasoningEffort = reasoningEffort;
  if (promptProvenance !== null) jsonPayload.promptProvenance = promptProvenance;
  if (executionSettings !== undefined) jsonPayload.executionSettings = executionSettings;
  const response = await fetchImpl(buildRealtimeCallUrl(endpointBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jsonPayload),
    credentials: "same-origin",
    signal:
      deadlineAt === undefined
        ? (signal ?? null)
        : AbortSignal.any([
            ...(signal === undefined ? [] : [signal]),
            AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())),
          ]),
  });
  const runIdentity = readLabRunIdentity(response.headers);
  if (
    attemptId !== undefined &&
    runIdentity !== null &&
    runIdentity.runId !== deriveLabAttemptRunId(attemptId)
  ) {
    throw new RealtimeCallError("Realtime connection returned another Lab experiment.", {
      code: "lab_connection_identity_mismatch",
    });
  }
  if (runIdentity !== null) onRunAllocated?.(runIdentity);
  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    throw new RealtimeCallError("Realtime connection reply could not be read.", { runIdentity });
  }
  if (!response.ok) {
    const errorPayload = parseWorkerErrorPayload(responseText);

    if (errorPayload?.error === "runtime_worker_unavailable") {
      throw new RealtimeCallError(RUNTIME_WORKER_UNAVAILABLE_MESSAGE, {
        code: errorPayload.error,
        reason: errorPayload.reason ?? null,
        runIdentity,
      });
    }

    throw new RealtimeCallError(
      responseText.length > 0 ? responseText : "Realtime call creation failed.",
      {
        code: errorPayload?.error ?? null,
        runIdentity,
      },
    );
  }

  if (runIdentity === null) {
    throw new Error("Realtime call creation did not return a Lab Run ID.");
  }

  let nativeReply;
  try {
    nativeReply = decodeRealtimeConnectionReply(JSON.parse(responseText));
    if (
      nativeReply.runId !== runIdentity.runId ||
      nativeReply.exchangeId !== jsonPayload.connection.exchangeId
    ) {
      throw new Error("connection_reply_mismatch");
    }
  } catch {
    throw new RealtimeCallError("Realtime connection returned an invalid browser reply.", {
      runIdentity,
    });
  }

  return {
    runIdentity,
    answerSdp: nativeReply.reply.sdp,
    sessionId: nativeReply.diagnostics.sessionId,
    sessionLocation: nativeReply.diagnostics.sessionLocation ?? null,
    upstreamRequestId: nativeReply.diagnostics.upstreamRequestId ?? null,
  };
}

type RequestRuntimeCloseOptions = {
  endpointBaseUrl: string;
  runId: string;
  timeoutMs: number;
  endReason?: string | null;
  microphoneStoppedAt?: number | null;
  finalTurnFlush?: {
    status: "sidebandClosed" | "timedOut" | "sidebandUnavailable";
    inputCommitSent?: boolean;
    completionReviewStatus?: "clean" | "warning";
    debugText?: string;
  } | null;
  fetchImpl?: typeof fetch;
};

type RuntimeCloseJsonPayload = {
  endReason?: string;
  microphoneStoppedAt?: number;
  finalTurnFlush?: NonNullable<RequestRuntimeCloseOptions["finalTurnFlush"]>;
};

export async function requestRuntimeClose({
  endpointBaseUrl,
  runId,
  timeoutMs,
  endReason = null,
  microphoneStoppedAt = null,
  finalTurnFlush = null,
  fetchImpl = fetch,
}: RequestRuntimeCloseOptions): Promise<RealtimeHangupResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const init: RequestInit = {
      method: "POST",
      signal: abortController.signal,
    };

    if (endReason !== null || microphoneStoppedAt !== null || finalTurnFlush !== null) {
      init.headers = {
        "Content-Type": "application/json",
      };
      const body: RuntimeCloseJsonPayload = {};
      if (endReason !== null) body.endReason = endReason;
      if (microphoneStoppedAt !== null) body.microphoneStoppedAt = microphoneStoppedAt;
      if (finalTurnFlush !== null) body.finalTurnFlush = finalTurnFlush;
      init.body = JSON.stringify(body);
    }

    const response = await fetchImpl(buildRuntimeCloseUrl(endpointBaseUrl, runId), init);

    if (response.ok) {
      const payload: unknown = await response
        .clone()
        .json()
        .catch(() => null);

      return {
        ok: true,
        status: response.status,
        debugText: `Requested controller close for ${runId}.`,
        completion:
          payload !== null && typeof payload === "object" && !Array.isArray(payload)
            ? readRuntimeCompletionPayload(payload)
            : null,
      };
    }

    const responseText = await response.text().catch(() => "");
    const errorPayload = parseWorkerErrorPayload(responseText);
    const code = errorPayload?.error ?? null;
    const detail = code ?? responseText.trim();

    return {
      ok: false,
      status: response.status,
      code,
      debugText:
        detail.length > 0
          ? `Runtime close returned ${response.status} (${detail}).`
          : `Runtime close returned ${response.status}.`,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ok: false,
        status: null,
        code: "runtime_close_timeout",
        debugText: `Runtime close timed out after ${timeoutMs}ms.`,
      };
    }

    return {
      ok: false,
      status: null,
      code: "runtime_close_failed",
      debugText: `Runtime close request failed: ${describeError(
        error instanceof Error || typeof error === "string" ? error : undefined,
      )}.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function readLabRunIdentity(headers: Headers): LabInterviewRunIdentity | null {
  const runId = headers.get(LAB_RUN_ID_HEADER)?.trim() ?? "";
  const startedAtText = headers.get(LAB_RUN_STARTED_AT_HEADER)?.trim() ?? "";
  const startedAt = Number(startedAtText);

  if (runId.length === 0 || !Number.isFinite(startedAt) || !Number.isInteger(startedAt)) {
    return null;
  }

  return {
    runId,
    startedAt,
  };
}

type SendRuntimePresenceOptions = {
  endpointBaseUrl: string;
  runId: string;
  mediaPresent: boolean;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export async function sendRuntimePresence({
  endpointBaseUrl,
  runId,
  mediaPresent,
  timeoutMs,
  fetchImpl = fetch,
}: SendRuntimePresenceOptions): Promise<RuntimePresenceResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(buildRuntimePresenceUrl(endpointBaseUrl, runId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mediaPresent,
      }),
      signal: abortController.signal,
    });

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
      };
    }

    const responseText = await response.text().catch(() => "");
    const errorPayload = parseWorkerErrorPayload(responseText);

    return {
      ok: false,
      status: response.status,
      code: errorPayload?.error ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      code:
        error instanceof DOMException && error.name === "AbortError"
          ? "runtime_presence_timeout"
          : "runtime_presence_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const readRuntimeCompletionPayload = boundary({
  schema: runtimeCompletionEnvelopeSchema,
  convert: (value): NonNullable<RealtimeHangupResult["completion"]> | null => {
    const completion = value.completion;
    if (completion === null || completion === undefined) {
      return null;
    }

    const warnings =
      completion.warnings?.filter((warning): warning is string => warning !== null) ?? [];
    const result: NonNullable<RealtimeHangupResult["completion"]> = {
      completionReviewStatus:
        completion.completionReviewStatus === "warning" || warnings.length > 0
          ? "warning"
          : "clean",
    };

    if (completion.endedAt !== undefined) {
      result.endedAt = completion.endedAt;
    }

    if (completion.endReason !== undefined) {
      result.endReason = completion.endReason;
    }

    if (completion.completionStatus !== undefined) {
      result.completionStatus = completion.completionStatus;
    }

    if (completion.completionDebugText !== undefined) {
      result.completionDebugText = completion.completionDebugText;
    }

    if (completion.transcriptTurnCount !== undefined) {
      result.transcriptTurnCount = completion.transcriptTurnCount;
    } else if (completion.transcriptSnapshot?.turnCount !== undefined) {
      result.transcriptTurnCount = completion.transcriptSnapshot.turnCount;
    }

    if (result.completionDebugText === undefined && warnings.length > 0) {
      result.completionDebugText = `Runtime Controller completed with warning(s): ${warnings.join(", ")}.`;
    }

    return result;
  },
});

function parseWorkerErrorPayload(
  value: string,
): { error: string | undefined; reason: string | undefined } | null {
  try {
    const parsed: unknown = JSON.parse(value);

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const error = "error" in parsed && typeof parsed.error === "string" ? parsed.error : undefined;
    const reason =
      "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : undefined;

    return error === undefined && reason === undefined
      ? null
      : {
          error,
          reason,
        };
  } catch {
    return null;
  }
}

function describeError(error: Error | string | undefined): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "request failed";
}

export async function sendRuntimeMediaReady({
  endpointBaseUrl,
  runId,
  signal,
  fetchImpl = fetch,
}: {
  endpointBaseUrl: string;
  runId: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const url = new URL(
    `/_api/runtime/runs/${encodeURIComponent(runId)}/media-ready`,
    endpointBaseUrl,
  );
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
  });
  return response.ok && z.object({ ok: z.literal(true) }).safeParse(await response.json()).success;
}

export function deriveLabAttemptRunId(attemptId: string): string {
  return `lab_${z.string().uuid().parse(attemptId)}`;
}
