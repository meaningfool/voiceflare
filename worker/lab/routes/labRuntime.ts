import { appendLabRuntimeDiagnosticRecords } from "../persistence/labD1.ts";
import {
  conversationInputCheckPath,
  conversationSelectionSchema,
  decodeConversationInputRefusal,
  isMissingCredentialsRefusal,
  type ConversationInputCheck,
} from "../../shared/contracts/conversationSelection.ts";
import { applicationStartupBudgetMs as labStartupBudgetMs } from "../../shared/contracts/interviewLifecyclePolicy.ts";
import { z } from "zod";
import { Data, Effect } from "effect";
import { callUntilDeadline } from "../../shared/deadline.ts";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  decodeRuntimeConnectionExchange,
  runtimeConnectionExchangeSchema,
  type RuntimeConnectionExchange,
} from "../../shared/contracts/runtimeConnection.ts";

import { corsHeaders, jsonResponse, safeString } from "../../shared/http.ts";
import {
  createLabRun,
  getLabDatabase,
  getLabTranscriptSnapshotRow,
  labRunExists,
  recordAppEndStatePersisted,
  recordCompletionDiagnostics,
  completeLabRunFromSnapshot,
  persistLabRunTranscriptSnapshot,
  recordLabRunSetupFailureEnd,
  recordSettingsSummary,
  recordSetupFailure,
  type PromptProvenance,
} from "../persistence/labD1.ts";
import {
  readDiagnosticsEnvironment,
  type D1DatabaseCapability,
} from "../../shared/persistence/runDiagnosticsD1.ts";
import {
  decodeRuntimeCompletedCallback,
  decodeRuntimeEventRecordEnvelope,
  decodeRuntimeTranscriptUpdatedCallback,
  isRuntimeEndReason,
  type RuntimeEndReason,
} from "../../shared/runtimeControllerCallback.ts";
import { SETTINGS_SUMMARY_HEADER } from "../../shared/runtimeHeaders.ts";
import {
  parseRuntimeStartRequest,
  type RuntimeDiagnosticsContext,
  type RuntimeStartRequest,
} from "../../shared/contracts/runtimeStart.ts";
import type { LabEnvironmentCapabilities } from "../types.ts";
import { createRuntimeTranscriptSnapshot } from "../../shared/runtimeTranscriptSnapshot.ts";

import {
  completeEmptyRuntimeUsage,
  parseRuntimeTerminalResult,
} from "../../shared/contracts/runtimeTerminalResult.ts";
import { decodeRuntimeReadinessCallback } from "../../shared/contracts/applicationStartup.ts";
import { persistLabTerminalResult } from "../persistence/labTerminalResults.ts";
import {
  decideLabStartup,
  recordLabRuntimeDispatchIntent,
  resolveOverdueLabStartup,
  toLabStartupDisposition,
} from "../persistence/labStartup.ts";
import { armLabStartupDeadline, wakeLabStartupDeadline } from "../labStartupDeadline.ts";

/** Lab's Realtime settings when its page sends none; Runtime's Realtime execution checks them. */
const defaultLabRealtimeSettings = {
  model: "gpt-realtime-2.1",
  voice: "marin",
  speed: 1,
  inputNoiseReduction: "far_field",
  semanticVadEagerness: "medium",
  maxOutputTokens: 700,
  truncation: "auto",
};

const labRunIdHeader = "X-Lab-Run-Id";
const labRunStartedAtHeader = "X-Lab-Run-Started-At";

type JsonObjectResult =
  | Readonly<{ ok: true; value: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; value: null }>;

type JsonRecord = Readonly<Record<string, unknown>>;
type LabRuntimeCompletionRequest = {
  runId: string;
  endReason: RuntimeEndReason;
  source: "browser_close";
  microphoneStoppedAt?: number;
  finalTurnFlush?: JsonRecord;
};
type SseFrameBatch = Readonly<{ complete: string[]; remainder: string }>;
type SseFrame = Readonly<{ event: string; data: string }>;
type RawInstructionsRuntimeStartCandidate = {
  runId: string;
  createdAt: number;
  startupExpiresAt: number;
  profile: string;
  connection: RuntimeConnectionExchange;
  selection: import("../../shared/contracts/conversationSelection.ts").ConversationSelection;
  execution: RuntimeStartRequest["execution"];
  reasoningEffort?: unknown;
  deliveryTarget?: import("../../shared/contracts/runtimeDelivery.ts").RuntimeDeliveryTarget;
  diagnosticsContext: RuntimeDiagnosticsContext;
  executionSettings?: unknown;
};

type LabDatabaseResult =
  | Readonly<{ ok: true; db: D1DatabaseCapability }>
  | Readonly<{ ok: false; response: Response }>;

type RuntimeFetchCapability = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

type RuntimeBindingResult =
  | Readonly<{ ok: true; runtime: RuntimeFetchCapability }>
  | Readonly<{ ok: false; response: Response }>;

type RuntimeFetchResult =
  | Readonly<{ ok: true; response: Response }>
  | Readonly<{
      ok: false;
      reason: Exclude<RuntimeUnavailableReason, "missing_binding">;
      response: Response;
    }>;

type LabRuntimeStartMetadata =
  | Readonly<{
      ok: true;
      promptProvenance: PromptProvenance | undefined;
      executionSettings: unknown;
    }>
  | Readonly<{
      ok: false;
      error: "invalid_run_start_request" | "invalid_prompt_provenance";
    }>;

type LabStartRunAllocation = {
  promptProvenance: PromptProvenance | undefined;
  diagnosticsEnvironment: string;
  startAttempt?: { attemptId: string; requestJson: string };
};

type LabRunIdentity = Readonly<{ runId: string; startedAt: number }>;

type RuntimeUnavailableReason =
  | "missing_binding"
  | "service_binding_fetch_failed"
  | "service_binding_unavailable";

export async function handleLabRuntimeControllerReadiness(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  let callback;
  try {
    callback = decodeRuntimeReadinessCallback(await request.json());
  } catch {
    return jsonResponse(request, env, { error: "invalid_runtime_readiness_callback" }, 400);
  }
  const db = getLabDatabase(env);
  let state = await resolveOverdueLabStartup(db, callback.runId, Date.now());
  if (state?.status === "pending")
    state = await decideLabStartup(db, {
      runId: callback.runId,
      decision: "succeeded",
      reason: "readiness_confirmed",
      now: Date.now(),
    });
  if (state === null) return jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
  await wakeLabStartupDeadline(env, callback.runId);
  return jsonResponse(request, env, toLabStartupDisposition(state));
}
export async function handleLabRuntimeStartup(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const runId = getRunIdFromRuntimeRunPath(new URL(request.url).pathname, "/startup");
  if (runId === null) return jsonResponse(request, env, { error: "missing_run_id" }, 400);
  const state = await resolveOverdueLabStartup(getLabDatabase(env), runId, Date.now());
  if (state === null) return jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
  await wakeLabStartupDeadline(env, runId);
  return jsonResponse(request, env, toLabStartupDisposition(state));
}

export async function handleLabRuntimeHealth(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const runtimeResult = getRuntimeWorkerResponse(request, env);

  if (!runtimeResult.ok) {
    return runtimeResult.response;
  }

  const runtimeUrl = toRuntimeUrl(request, "/health");
  const runtimeFetchResult = await fetchRuntimeWorker(
    request,
    env,
    runtimeResult.runtime,
    runtimeUrl,
  );

  if (!runtimeFetchResult.ok) {
    return runtimeFetchResult.response;
  }

  return toBrowserRuntimeResponse(request, env, runtimeFetchResult.response);
}

export async function handleLabRuntimeControllerCompletion(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const payload = await readJsonObject(request);

  if (!payload.ok) {
    return jsonResponse(request, env, { error: "invalid_runtime_completion_callback" }, 400);
  }

  const terminal = parseRuntimeTerminalResult(payload.value);
  if (terminal !== null) {
    const db = getLabDatabase(env);
    const status = await persistLabTerminalResult(db, terminal);
    if (status === null) return jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
    await wakeLabStartupDeadline(env, terminal.runId);
    const accepted = status === "completed" || status === "idempotent";
    if (accepted) {
      await recordDiagnosticBestEffort(() =>
        recordCompletionDiagnostics(db, {
          runId: terminal.runId,
          completionStatus: "runtimeCompleted",
          completionReviewStatus:
            terminal.outcome !== "failed_to_start" &&
            terminal.transcriptCompleteness === "incomplete"
              ? "warning"
              : "clean",
          completionDebugText:
            terminal.outcome === "failed_to_start"
              ? "Runtime failed before the Interview became live."
              : `Runtime completed with ${terminal.transcriptSnapshot.turnCount} Transcript turns.`,
        }),
      );
      await recordDiagnosticBestEffort(() =>
        recordAppEndStatePersisted(db, {
          runId: terminal.runId,
          outcome: terminal.outcome === "completed" ? "ended" : "failed",
          endReason: terminal.outcome === "completed" ? terminal.reason : "runtime_failed",
          observedAt: terminal.endedAt,
        }),
      );
    }
    if (terminal.outcome === "failed_to_start")
      return jsonResponse(
        request,
        env,
        accepted ? { ok: true } : { error: "terminal_result_conflict" },
        accepted ? 200 : 409,
      );
    const snapshot = await getLabTranscriptSnapshotRow(db, terminal.runId);
    return jsonResponse(
      request,
      env,
      {
        version: 2,
        status,
        storedSnapshot: snapshot?.storedSnapshot ?? null,
        requestedMatches: accepted,
      },
      status === "snapshot_mismatch" ? 503 : status === "completion_conflict" ? 409 : 200,
    );
  }

  let callback;

  try {
    callback = decodeRuntimeCompletedCallback(payload.value);
  } catch {
    return jsonResponse(request, env, { error: "invalid_runtime_completion_callback" }, 400);
  }

  let db: D1DatabaseCapability;

  try {
    db = getLabDatabase(env);
  } catch {
    return jsonResponse(request, env, { error: "missing_lab_database" }, 500);
  }

  const receipt = await completeLabRunFromSnapshot(db, {
    completion: callback.completion,
  });

  if (receipt === null) {
    return jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
  }

  if (receipt.status === "completed") {
    await recordDiagnosticBestEffort(() =>
      recordCompletionDiagnostics(db, {
        runId: callback.completion.runId,
        completionStatus: "runtimeCompleted",
        completionReviewStatus: callback.completion.warnings.length > 0 ? "warning" : "clean",
        completionDebugText: `Runtime completed with ${callback.completion.transcriptSnapshot.turnCount} Transcript turns.`,
      }),
    );
    await recordDiagnosticBestEffort(() =>
      recordAppEndStatePersisted(db, {
        runId: callback.completion.runId,
        outcome: callback.completion.outcome,
        endReason: callback.completion.endReason,
        observedAt: callback.completion.endedAt,
      }),
    );
  }

  return jsonResponse(
    request,
    env,
    receipt,
    receipt.status === "snapshot_mismatch" || receipt.status === "completion_conflict" ? 409 : 200,
  );
}

async function recordDiagnosticBestEffort<Result>(write: () => Promise<Result>): Promise<void> {
  try {
    await write();
  } catch {
    // Diagnostics must not block the runtime completion callback.
  }
}

export async function handleLabRuntimeControllerTranscript(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const payload = await readJsonObject(request);

  if (!payload.ok) {
    return jsonResponse(request, env, { error: "invalid_runtime_transcript_callback" }, 400);
  }

  let db: D1DatabaseCapability;

  try {
    db = getLabDatabase(env);
  } catch {
    return jsonResponse(request, env, { error: "missing_lab_database" }, 500);
  }

  let callback;

  try {
    callback = decodeRuntimeTranscriptUpdatedCallback(payload.value);
  } catch {
    return jsonResponse(request, env, { error: "invalid_runtime_transcript_callback" }, 400);
  }

  const expectedSnapshot = await createRuntimeTranscriptSnapshot(
    callback.snapshot.revision,
    callback.snapshot.transcript,
  );

  if (
    expectedSnapshot.digest !== callback.snapshot.digest ||
    expectedSnapshot.turnCount !== callback.snapshot.turnCount
  ) {
    return jsonResponse(request, env, { error: "invalid_runtime_transcript_callback" }, 400);
  }

  const receipt = await persistLabRunTranscriptSnapshot(db, {
    runId: callback.runId,
    snapshot: callback.snapshot,
  });

  if (receipt === null) {
    return jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
  }

  return jsonResponse(
    request,
    env,
    receipt,
    receipt.status === "conflict" || receipt.status === "sealed" ? 409 : 200,
  );
}

const labConnectionStartSchema = z.strictObject({
  attemptId: z.string().uuid().optional(),
  profile: z.string().trim().min(1),
  connection: runtimeConnectionExchangeSchema,
  selection: conversationSelectionSchema,
  agentInput: z.json(),
  reasoningEffort: z.unknown().optional(),
  promptProvenance: z.unknown().optional(),
  executionSettings: z.unknown().optional(),
});
const labConnectionOwnFieldsSchema = z.unknown().superRefine((value, context) => {
  if (!isRecord(value)) return;
  for (const [source, fields, path] of [
    [value, labConnectionStartSchema.keyof().options, []],
    [value.connection, runtimeConnectionExchangeSchema.keyof().options, ["connection"]],
  ] as const) {
    if (!isRecord(source)) continue;
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
export const decodeLabConnectionStart = boundary({
  schema: labConnectionOwnFieldsSchema.pipe(labConnectionStartSchema),
  convert: (value) => value,
});

/** Lab's Start refuses a body that is not a connection exchange start as unreadable. */
async function readLabConnectionStart(request: Request) {
  const invalid = { ok: false as const, error: "invalid_run_start_request" };
  if (!(request.headers.get("Content-Type") ?? "").includes("application/json")) return invalid;
  const payload = await readJsonObject(request);
  if (!payload.ok) return invalid;
  try {
    return { ok: true as const, ...decodeLabConnectionStart(payload.value) };
  } catch {
    return invalid;
  }
}

export async function handleLabRuntimeConnection(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const runId = getRunIdFromRuntimeRunPath(new URL(request.url).pathname, "/connection");
  if (runId === null) return jsonResponse(request, env, { error: "missing_run_id" }, 400);
  const dbResult = await getExistingLabRunDatabase(request, env, runId);
  if (!dbResult.ok) return dbResult.response;
  let connection: RuntimeConnectionExchange;
  try {
    connection = decodeRuntimeConnectionExchange(await request.json());
  } catch {
    return jsonResponse(request, env, { error: "invalid_connection_exchange" }, 400);
  }
  const runtime = getRuntimeWorkerResponse(request, env);
  if (!runtime.ok) return runtime.response;
  const result = await fetchRuntimeWorkerRequest(
    request,
    env,
    runtime.runtime,
    new Request(
      toRuntimeUrl(request, `/_runtime/controllers/${encodeURIComponent(runId)}/connection`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, connection }),
      },
    ),
  );
  return toBrowserRuntimeResponse(request, env, result.response);
}

export async function handleLabRunStart(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const metadata = await readLabRuntimeStartMetadata(request.clone());
  const body = await readLabConnectionStart(request);

  if (!metadata.ok) {
    return jsonResponse(request, env, { error: metadata.error }, 400);
  }

  if (!body.ok) {
    return jsonResponse(request, env, { error: body.error }, 400);
  }

  const dbResult = getLabRunDatabaseResponse(request, env);

  if (!dbResult.ok) {
    return dbResult.response;
  }

  let labRun;
  try {
    const runOptions: LabStartRunAllocation = {
      promptProvenance: metadata.promptProvenance,
      diagnosticsEnvironment: readDiagnosticsEnvironment(env),
    };
    if (body.attemptId !== undefined) {
      const { ok: _ok, ...retainedRequest } = body;
      runOptions.startAttempt = {
        attemptId: body.attemptId,
        requestJson: JSON.stringify(retainedRequest),
      };
    }
    labRun = await createLabRun(dbResult.db, runOptions);
  } catch (error) {
    if (error instanceof Error && error.message === "lab_start_attempt_conflict")
      return jsonResponse(request, env, { error: "lab_start_attempt_conflict" }, 409);
    throw error;
  }
  const runId = labRun.runId;
  try {
    await armLabStartupDeadline(env, runId, labRun.startedAt + labStartupBudgetMs);
  } catch (error) {
    await recordSetupFailure(dbResult.db, {
      runId,
      failureKind: "runtime_worker_unavailable",
      source: "lab_worker",
      errorText: error instanceof Error ? error.message : "startup_deadline_unavailable",
      code: "startup_deadline_unavailable",
    });
    await recordRuntimeFailedEnd(dbResult.db, runId);
    return toBrowserRuntimeResponse(
      request,
      env,
      jsonResponse(request, env, { error: "startup_deadline_unavailable" }, 503),
      labRun,
    );
  }
  const runtimeResult = getRuntimeWorkerResponse(request, env);

  if (!runtimeResult.ok) {
    await recordSetupFailure(dbResult.db, {
      runId,
      failureKind: "runtime_worker_unavailable",
      source: "lab_worker",
      errorText: "Runtime Worker is not reachable through the RUNTIME_WORKER service binding.",
      code: "missing_binding",
    });
    await recordRuntimeFailedEnd(dbResult.db, runId);
    return toBrowserRuntimeResponse(request, env, runtimeResult.response, labRun);
  }

  let runtimeStartRequest: RuntimeStartRequest;

  try {
    const diagnosticsContext = {
      surface: "lab",
      environment: readDiagnosticsEnvironment(env),
      appResourceKind: "lab_run",
      appResourceId: runId,
    } satisfies RuntimeDiagnosticsContext;

    runtimeStartRequest = await buildRawInstructionsLabRuntimeStartRequest({
      runId,
      startedAt: labRun.startedAt,
      profile: body.profile,
      connection: body.connection,
      selection: body.selection,
      agentInput: body.agentInput,
      reasoningEffort: body.reasoningEffort,
      executionSettings: metadata.executionSettings,
      startupExpiresAt: labRun.startedAt + labStartupBudgetMs,
      diagnosticsContext,
      checkInput: (check) =>
        checkLabConversationInput(
          request,
          env,
          runtimeResult.runtime,
          check,
          labRun.startedAt + labStartupBudgetMs,
        ),
    });
  } catch (error) {
    if (error instanceof LabConversationInputCheckUnavailable) {
      await recordSetupFailure(dbResult.db, {
        runId,
        failureKind: "runtime_worker_unavailable",
        source: "lab_worker",
        errorText: "Runtime Worker is not reachable through the RUNTIME_WORKER service binding.",
        code: error.reason,
      });
      await recordRuntimeFailedEnd(dbResult.db, runId);
      return toBrowserRuntimeResponse(request, env, error.response, labRun);
    }
    await recordSetupFailure(dbResult.db, {
      runId,
      failureKind: "provider_signaling",
      source: "lab_worker",
      errorText: error instanceof Error ? error.message : "invalid_runtime_start_request",
      code: error instanceof Error ? error.message : "invalid_runtime_start_request",
    });
    await recordRuntimeFailedEnd(dbResult.db, runId);
    // A combination Runtime cannot start is unavailable, as Runtime's Start answers it.
    if (error instanceof Error && isMissingCredentialsRefusal(error.message))
      return toBrowserRuntimeResponse(
        request,
        env,
        jsonResponse(request, env, { error: error.message }, 503),
        labRun,
      );
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : "invalid_runtime_start_request" },
      400,
    );
  }

  const runtimeUrl = toRuntimeUrl(
    request,
    `/_runtime/controllers/${encodeURIComponent(runId)}/connection`,
  );
  const dispatch = await recordLabRuntimeDispatchIntent(dbResult.db, runId, Date.now());
  if (dispatch === null || dispatch.status === "failed" || Date.now() >= dispatch.expiresAt)
    return toBrowserRuntimeResponse(
      request,
      env,
      jsonResponse(request, env, { error: "lab_startup_expired" }, 409),
      labRun,
    );
  const runtimeFetchResult = await fetchLabRuntimeStart(
    request,
    env,
    runtimeResult.runtime,
    new Request(runtimeUrl, {
      method: "POST",
      headers: {
        "X-Runtime-Application": "lab",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(runtimeStartRequest),
    }),
    labRun.startedAt + labStartupBudgetMs,
  );

  if (!runtimeFetchResult.ok) {
    await recordSetupFailure(dbResult.db, {
      runId,
      failureKind: "runtime_worker_unavailable",
      source: "lab_worker",
      errorText: "Runtime Worker is not reachable through the RUNTIME_WORKER service binding.",
      code: runtimeFetchResult.reason,
    });
    // The browser receives a failure either way. The required stop resolves whether Runtime
    // received this Start: it ends an accepted Run, or fences one it never accepted.
    await recordRuntimeFailedEnd(dbResult.db, runId);
    await requestLabStartupWake(env, runId);
    return toBrowserRuntimeResponse(request, env, runtimeFetchResult.response, labRun);
  }

  const runtimeResponse = runtimeFetchResult.response;
  if (runtimeResponse.ok) {
    const encodedSummary = runtimeResponse.headers.get(SETTINGS_SUMMARY_HEADER);
    if (encodedSummary !== null) {
      try {
        const summary = parseJsonObject(decodeURIComponent(encodedSummary));
        if (summary !== null)
          await recordSettingsSummary(dbResult.db, {
            runId,
            settingsSummary: summary,
          });
      } catch {
        // Provenance storage must not change provider call success.
      }
    }
  }

  if (!runtimeResponse.ok) {
    await recordSetupFailure(dbResult.db, {
      runId,
      failureKind: "provider_signaling",
      source: "lab_worker",
      errorText: await describeRuntimeFailure(runtimeResponse),
      code: `runtime_http_${runtimeResponse.status}`,
    });
    await recordRuntimeFailedEnd(dbResult.db, runId);
    await requestLabStartupWake(env, runId);
  }

  return toBrowserRuntimeResponse(request, env, runtimeResponse, labRun);
}

export async function handleLabRuntimeClose(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const url = new URL(request.url);
  const runId = getRunIdFromRuntimeRunPath(url.pathname, "/complete");
  const body = await readOptionalJsonObject(request);

  if (runId === null) {
    return jsonResponse(request, env, { error: "missing_run_id" }, 400);
  }

  if (!body.ok) {
    return jsonResponse(request, env, { error: "invalid_runtime_completion_request" }, 400);
  }

  const dbResult = await getExistingLabRunDatabase(request, env, runId);

  if (!dbResult.ok) {
    return dbResult.response;
  }

  const runtimeResult = getRuntimeWorkerResponse(request, env);

  if (!runtimeResult.ok) {
    return runtimeResult.response;
  }

  const endReason = readCompletionEndReason(body.value.endReason);
  if (endReason === null) {
    return jsonResponse(request, env, { error: "invalid_end_reason" }, 400);
  }

  const completionRequest: LabRuntimeCompletionRequest = {
    runId,
    endReason,
    source: "browser_close",
  };

  if (isFiniteTimestamp(body.value.microphoneStoppedAt)) {
    completionRequest.microphoneStoppedAt = body.value.microphoneStoppedAt;
  }

  if (isRecord(body.value.finalTurnFlush)) {
    completionRequest.finalTurnFlush = body.value.finalTurnFlush;
  }

  const runtimeUrl = toRuntimeUrl(
    request,
    `/_runtime/controllers/${encodeURIComponent(runId)}/complete`,
  );
  const runtimeFetchResult = await fetchRuntimeWorkerRequest(
    request,
    env,
    runtimeResult.runtime,
    new Request(runtimeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(completionRequest),
    }),
  );

  if (!runtimeFetchResult.ok) {
    return runtimeFetchResult.response;
  }

  return toBrowserRuntimeResponse(request, env, runtimeFetchResult.response);
}

function toBrowserRuntimeEventStreamResponse(
  request: Request,
  env: LabEnvironmentCapabilities,
  runtimeResponse: Response,
  db: D1DatabaseCapability,
  runId: string,
): Response {
  if (runtimeResponse.body === null) {
    return toBrowserRuntimeResponse(request, env, runtimeResponse);
  }

  const headers = new Headers(runtimeResponse.headers);
  headers.delete(SETTINGS_SUMMARY_HEADER);

  for (const [key, value] of corsHeaders(request, env)) {
    headers.set(key, value);
  }

  return new Response(createRuntimeEventPersistingStream(runtimeResponse.body, db, runId), {
    status: runtimeResponse.status,
    statusText: runtimeResponse.statusText,
    headers,
  });
}

function createRuntimeEventPersistingStream(
  body: ReadableStream<unknown>,
  db: D1DatabaseCapability,
  runId: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";

  const handleFrame = async (frame: string): Promise<void> => {
    const parsed = parseSseFrame(frame);
    const payload = parseJsonObject(parsed.data);
    try {
      await appendRuntimeStreamRecord(db, runId, parsed.event, payload);
    } catch {
      // Runtime Event persistence is diagnostic and must not break the browser event stream.
    }
  };

  return body.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      async transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError("invalid_runtime_event_stream_chunk");
        }

        buffer += decoder.decode(chunk, { stream: true });
        const frames = splitCompleteSseFrames(buffer);
        buffer = frames.remainder;

        for (const frame of frames.complete) {
          await handleFrame(frame);
        }

        controller.enqueue(chunk);
      },
      async flush() {
        buffer += decoder.decode();

        if (buffer.trim().length > 0) {
          await handleFrame(buffer.trim());
        }
      },
    }),
  );
}

/**
 * Attaches a browser's live media to an existing Lab Run: Lab authorizes the Run and forwards
 * the WebSocket upgrade privately to Runtime, whose Run accepts one attachment.
 */
export async function handleLabRuntimeMediaAttachment(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const runId = getRunIdFromRuntimeRunPath(new URL(request.url).pathname, "/media");
  if (runId === null) return jsonResponse(request, env, { error: "missing_run_id" }, 400);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return jsonResponse(request, env, { error: "media_attachment_upgrade_required" }, 426);
  const dbResult = await getExistingLabRunDatabase(request, env, runId);
  if (!dbResult.ok) return dbResult.response;
  const runtimeResult = getRuntimeWorkerResponse(request, env);
  if (!runtimeResult.ok) return runtimeResult.response;
  const forwarded = await fetchRuntimeWorkerRequest(
    request,
    env,
    runtimeResult.runtime,
    new Request(
      toRuntimeUrl(request, `/_runtime/controllers/${encodeURIComponent(runId)}/attachment`),
      { headers: request.headers },
    ),
  );
  // The upgraded response carries the attachment itself; it is returned unchanged.
  return forwarded.response;
}

export async function handleLabRuntimeMediaReady(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const runId = getRunIdFromRuntimeRunPath(new URL(request.url).pathname, "/media-ready");
  if (runId === null) return jsonResponse(request, env, { error: "missing_run_id" }, 400);

  const dbResult = await getExistingLabRunDatabase(request, env, runId);
  if (!dbResult.ok) return dbResult.response;

  const body = await readJsonObject(request);
  if (!body.ok) {
    return jsonResponse(request, env, { error: "invalid_runtime_media_ready_request" }, 400);
  }

  const runtimeResult = getRuntimeWorkerResponse(request, env);
  if (!runtimeResult.ok) return runtimeResult.response;

  const runtimeFetchResult = await fetchRuntimeWorkerRequest(
    request,
    env,
    runtimeResult.runtime,
    new Request(
      toRuntimeUrl(request, `/_runtime/controllers/${encodeURIComponent(runId)}/media-ready`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    ),
  );
  if (!runtimeFetchResult.ok) return runtimeFetchResult.response;
  return toBrowserRuntimeResponse(request, env, runtimeFetchResult.response);
}

export async function handleLabRuntimePresence(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const url = new URL(request.url);
  const runId = safeString(url.searchParams.get("runId"), "");
  const body = await readOptionalJsonObject(request);

  if (runId.length === 0) {
    return jsonResponse(request, env, { error: "missing_run_id" }, 400);
  }

  if (!body.ok) {
    return jsonResponse(request, env, { error: "invalid_runtime_presence_request" }, 400);
  }

  if (typeof body.value.mediaPresent !== "boolean") {
    return jsonResponse(request, env, { error: "invalid_runtime_presence_request" }, 400);
  }

  const dbResult = await getExistingLabRunDatabase(request, env, runId);

  if (!dbResult.ok) {
    return dbResult.response;
  }

  const runtimeResult = getRuntimeWorkerResponse(request, env);

  if (!runtimeResult.ok) {
    return runtimeResult.response;
  }

  const runtimeUrl = toRuntimeUrl(
    request,
    `/_runtime/controllers/${encodeURIComponent(runId)}/presence`,
  );
  const runtimeFetchResult = await fetchRuntimeWorkerRequest(
    request,
    env,
    runtimeResult.runtime,
    new Request(runtimeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId,
        mediaPresent: body.value.mediaPresent,
      }),
    }),
  );

  if (!runtimeFetchResult.ok) {
    return runtimeFetchResult.response;
  }

  return toBrowserRuntimeResponse(request, env, runtimeFetchResult.response);
}

export async function handleLabRuntimeEvents(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const url = new URL(request.url);
  const runId = safeString(url.searchParams.get("runId"), "");

  if (runId.length === 0) {
    return jsonResponse(request, env, { error: "missing_run_id" }, 400);
  }

  const dbResult = await getExistingLabRunDatabase(request, env, runId);

  if (!dbResult.ok) {
    return dbResult.response;
  }

  const runtimeResult = getRuntimeWorkerResponse(request, env);

  if (!runtimeResult.ok) {
    return runtimeResult.response;
  }

  const runtimeUrl = toRuntimeUrl(
    request,
    `/_runtime/controllers/${encodeURIComponent(runId)}/events`,
  );
  const runtimeFetchResult = await fetchRuntimeWorker(
    request,
    env,
    runtimeResult.runtime,
    runtimeUrl,
  );

  if (!runtimeFetchResult.ok) {
    return runtimeFetchResult.response;
  }

  return toBrowserRuntimeEventStreamResponse(
    request,
    env,
    runtimeFetchResult.response,
    dbResult.db,
    runId,
  );
}

async function readJsonObject(request: Request): Promise<JsonObjectResult> {
  try {
    const value: unknown = await request.json();

    return isRecord(value) ? { ok: true, value } : { ok: false, value: null };
  } catch {
    return {
      ok: false,
      value: null,
    };
  }
}

async function readOptionalJsonObject(request: Request): Promise<JsonObjectResult> {
  if (request.body === null) {
    return {
      ok: true,
      value: {},
    };
  }

  return readJsonObject(request);
}

async function readLabRuntimeStartMetadata(request: Request): Promise<LabRuntimeStartMetadata> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (!contentType.includes("application/json")) {
    return {
      ok: true,
      promptProvenance: undefined,
      executionSettings: undefined,
    };
  }

  const payload = await readJsonObject(request);

  if (!payload.ok) {
    return {
      ok: false,
      error: "invalid_run_start_request",
    };
  }

  const promptProvenance = payload.value.promptProvenance;

  if (promptProvenance !== undefined && !isPromptProvenance(promptProvenance)) {
    return {
      ok: false,
      error: "invalid_prompt_provenance",
    };
  }

  return {
    ok: true,
    promptProvenance,
    executionSettings: payload.value.executionSettings,
  };
}

function getLabRunDatabaseResponse(
  request: Request,
  env: LabEnvironmentCapabilities,
): LabDatabaseResult {
  try {
    return {
      ok: true,
      db: getLabDatabase(env),
    };
  } catch {
    return {
      ok: false,
      response: jsonResponse(request, env, { error: "missing_lab_database" }, 500),
    };
  }
}

async function getExistingLabRunDatabase(
  request: Request,
  env: LabEnvironmentCapabilities,
  runId: string,
): Promise<LabDatabaseResult> {
  const dbResult = getLabRunDatabaseResponse(request, env);

  if (!dbResult.ok) {
    return dbResult;
  }

  const db = dbResult.db;

  if (!(await labRunExists(db, runId))) {
    return {
      ok: false,
      response: jsonResponse(request, env, { error: "lab_run_not_found" }, 404),
    };
  }

  return {
    ok: true,
    db,
  };
}

/** The deadline owner sends the failed Start's required stop now; its alarm remains the fallback. */
async function requestLabStartupWake(
  env: LabEnvironmentCapabilities,
  runId: string,
): Promise<void> {
  await wakeLabStartupDeadline(env, runId).catch(() => undefined);
}

async function recordRuntimeFailedEnd(db: D1DatabaseCapability, runId: string): Promise<void> {
  const state = await decideLabStartup(db, {
    runId,
    decision: "failed",
    reason: "definitive_setup_failure",
    now: Date.now(),
  });
  if (state?.dispatchIntentAt === null) {
    await persistLabTerminalResult(db, {
      runId,
      outcome: "failed_to_start",
      endedAt: Date.now(),
      runtimeUsage: completeEmptyRuntimeUsage,
    });
    return;
  }
  await recordLabRunSetupFailureEnd(db, {
    runId,
    endedAt: Date.now(),
  });
}

function getRuntimeWorkerResponse(
  request: Request,
  env: LabEnvironmentCapabilities,
): RuntimeBindingResult {
  const runtime: unknown = env.RUNTIME_WORKER;

  if (!isRuntimeFetchCapability(runtime)) {
    return {
      ok: false,
      response: runtimeWorkerUnavailableResponse(request, env, "missing_binding"),
    };
  }

  return {
    ok: true,
    runtime,
  };
}

async function fetchRuntimeWorker(
  request: Request,
  env: LabEnvironmentCapabilities,
  runtime: RuntimeFetchCapability,
  runtimeUrl: string,
): Promise<RuntimeFetchResult> {
  return fetchRuntimeWorkerRequest(
    request,
    env,
    runtime,
    await createRuntimeRequest(request, runtimeUrl),
  );
}

class LabRuntimeStartTransportFailure extends Data.TaggedError("LabRuntimeStartTransportFailure")<{
  cause: unknown;
}> {}
class LabRuntimeStartTimeout extends Data.TaggedError("LabRuntimeStartTimeout") {}

async function fetchLabRuntimeStart(
  request: Request,
  env: LabEnvironmentCapabilities,
  runtime: RuntimeFetchCapability,
  runtimeRequest: Request,
  expiresAt: number,
): Promise<RuntimeFetchResult> {
  const unavailable = (): RuntimeFetchResult => ({
    ok: false,
    reason: "service_binding_fetch_failed",
    response: runtimeWorkerUnavailableResponse(request, env, "service_binding_fetch_failed"),
  });
  return Effect.runPromise(
    callUntilDeadline({
      deadlineAt: expiresAt,
      operation: async (signal) => {
        const result = await fetchRuntimeWorkerRequest(
          request,
          env,
          runtime,
          new Request(runtimeRequest, { signal }),
        );
        if (!result.ok) return result;
        const body = await result.response.arrayBuffer();
        return { ok: true as const, response: new Response(body, result.response) };
      },
      onTransportFailure: (cause) => new LabRuntimeStartTransportFailure({ cause }),
      onTimeout: () => new LabRuntimeStartTimeout(),
    }).pipe(
      Effect.catchTags({
        LabRuntimeStartTransportFailure: () => Effect.sync(unavailable),
        LabRuntimeStartTimeout: () => Effect.sync(unavailable),
      }),
    ),
  );
}

async function fetchRuntimeWorkerRequest(
  request: Request,
  env: LabEnvironmentCapabilities,
  runtime: RuntimeFetchCapability,
  runtimeRequest: Request,
): Promise<RuntimeFetchResult> {
  try {
    const runtimeResponse = await runtime.fetch(runtimeRequest);
    const unavailableResponse = await getRuntimeWorkerUnavailableResponse(
      request,
      env,
      runtimeResponse,
    );

    return unavailableResponse === null
      ? { ok: true, response: runtimeResponse }
      : {
          ok: false,
          reason: "service_binding_unavailable",
          response: unavailableResponse,
        };
  } catch {
    return {
      ok: false,
      reason: "service_binding_fetch_failed",
      response: runtimeWorkerUnavailableResponse(request, env, "service_binding_fetch_failed"),
    };
  }
}

async function createRuntimeRequest(request: Request, runtimeUrl: string): Promise<Request> {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  return new Request(runtimeUrl, init);
}

async function getRuntimeWorkerUnavailableResponse(
  request: Request,
  env: LabEnvironmentCapabilities,
  runtimeResponse: Response,
): Promise<Response | null> {
  if (runtimeResponse.status !== 503) {
    return null;
  }

  const contentType = runtimeResponse.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    return null;
  }

  const text = await runtimeResponse
    .clone()
    .text()
    .catch(() => "");

  return isRuntimeWorkerUnavailableText(text)
    ? runtimeWorkerUnavailableResponse(request, env, "service_binding_unavailable")
    : null;
}

function runtimeWorkerUnavailableResponse(
  request: Request,
  env: LabEnvironmentCapabilities,
  reason: RuntimeUnavailableReason,
): Response {
  return jsonResponse(
    request,
    env,
    {
      error: "runtime_worker_unavailable",
      reason,
      message: "Runtime Worker is not reachable through the RUNTIME_WORKER service binding.",
      recovery:
        "Start the Runtime Worker first, restart the Lab Worker, then check /_api/runtime/health.",
    },
    503,
  );
}

function isRuntimeWorkerUnavailableText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("worker") &&
    (normalized.includes("not found") || normalized.includes("not connected"))
  );
}

function toRuntimeUrl(request: Request, pathname: string): string {
  const url = new URL(request.url);
  url.pathname = pathname;
  return url.toString();
}

function toBrowserRuntimeResponse(
  request: Request,
  env: LabEnvironmentCapabilities,
  runtimeResponse: Response,
  labRun: LabRunIdentity | null = null,
): Response {
  const headers = new Headers(runtimeResponse.headers);
  headers.delete(SETTINGS_SUMMARY_HEADER);

  for (const [key, value] of corsHeaders(request, env)) {
    headers.set(key, value);
  }

  if (labRun !== null) {
    headers.set(labRunIdHeader, labRun.runId);
    headers.set(labRunStartedAtHeader, String(labRun.startedAt));
    exposeHeaders(headers, [labRunIdHeader, labRunStartedAtHeader]);
  }

  return new Response(runtimeResponse.body, {
    status: runtimeResponse.status,
    statusText: runtimeResponse.statusText,
    headers,
  });
}

function exposeHeaders(headers: Headers, headerNames: readonly string[]): void {
  const exposed = new Set<string>(
    (headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );

  for (const headerName of headerNames) {
    exposed.add(headerName);
  }

  headers.set("Access-Control-Expose-Headers", [...exposed].join(","));
}

async function appendRuntimeStreamRecord(
  db: D1DatabaseCapability,
  runId: string,
  event: string,
  payload: JsonRecord | null,
): Promise<void> {
  if (event !== "runtime.event_recorded") {
    return;
  }

  let record;

  try {
    record = decodeRuntimeEventRecordEnvelope(payload?.record);
  } catch {
    return;
  }

  await appendLabRuntimeDiagnosticRecords(db, runId, [record]);
}

function splitCompleteSseFrames(buffer: string): SseFrameBatch {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return {
    complete: parts.slice(0, -1).filter((frame) => frame.length > 0),
    remainder: parts.at(-1) ?? "",
  };
}

function parseSseFrame(frame: string): SseFrame {
  let event = "message";
  const data: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  return {
    event,
    data: data.join("\n"),
  };
}

function parseJsonObject(value: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function describeRuntimeFailure(response: Response): Promise<string> {
  const fallback = `Runtime call failed with HTTP ${response.status}.`;

  try {
    const payload = await response.clone().json();

    if (isRecord(payload) && typeof payload.error === "string") {
      return typeof payload.message === "string"
        ? `${payload.error}: ${payload.message}`
        : payload.error;
    }
  } catch {
    // Fall through to compact text fallback.
  }

  try {
    const text = await response.clone().text();
    return text.trim().length === 0 ? fallback : text.trim().slice(0, 300);
  } catch {
    return fallback;
  }
}

function isPromptProvenance<Value>(value: Value): value is Value & PromptProvenance {
  return (
    isRecord(value) &&
    typeof value.promptId === "string" &&
    value.promptId.trim().length > 0 &&
    (value.promptFileName === undefined ||
      (typeof value.promptFileName === "string" && value.promptFileName.trim().length > 0)) &&
    typeof value.contentHash === "string" &&
    value.contentHash.trim().length > 0
  );
}

function isRecord<Value>(value: Value): value is Value & JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeFetchCapability<Value>(value: Value): value is Value & RuntimeFetchCapability {
  return isRecord(value) && typeof value.fetch === "function";
}

function readCompletionEndReason<Value>(value: Value): RuntimeEndReason | null {
  if (value === undefined) return "participant_stopped";
  return isRuntimeEndReason(value) ? value : null;
}

function isFiniteTimestamp<Value>(value: Value): value is Value & number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function getRunIdFromRuntimeRunPath(pathname: string, suffix: string): string | null {
  const prefix = "/_api/runtime/runs/";

  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }

  const encodedRunId = pathname.slice(prefix.length, -suffix.length);

  try {
    const runId = decodeURIComponent(encodedRunId).trim();
    return runId.length > 0 ? runId : null;
  } catch {
    return null;
  }
}

class LabConversationInputCheckUnavailable extends Data.TaggedError(
  "LabConversationInputCheckUnavailable",
)<{
  reason: Exclude<RuntimeUnavailableReason, "missing_binding">;
  response: Response;
}> {}

/**
 * The response Lab gave input its Conversation rejects when Lab decoded that input itself; it
 * keeps that response now that Runtime's catalog decides.
 */
const labRejectedConversationInput = "The boundary schema rejected the input";

/**
 * Asks Runtime's catalog whether the selected Conversation accepts the input, and its execution
 * the settings, before any Run starts. A refusal throws the code Lab answers with; an
 * unreachable Runtime throws `LabConversationInputCheckUnavailable`.
 */
async function checkLabConversationInput(
  request: Request,
  env: LabEnvironmentCapabilities,
  runtime: RuntimeFetchCapability,
  check: ConversationInputCheck,
  expiresAt: number,
): Promise<void> {
  const unavailable = (
    reason: Exclude<RuntimeUnavailableReason, "missing_binding">,
    response = runtimeWorkerUnavailableResponse(request, env, reason),
  ) => new LabConversationInputCheckUnavailable({ reason, response });
  const verdict = await Effect.runPromise(
    callUntilDeadline({
      deadlineAt: expiresAt,
      operation: async (signal) => {
        const result = await fetchRuntimeWorkerRequest(
          request,
          env,
          runtime,
          new Request(toRuntimeUrl(request, conversationInputCheckPath), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(check),
            signal,
          }),
        );
        if (!result.ok) return unavailable(result.reason, result.response);
        if (result.response.status === 204) return null;
        if (result.response.status !== 400) {
          await result.response.body?.cancel();
          return unavailable("service_binding_unavailable");
        }
        try {
          return decodeConversationInputRefusal(await result.response.json());
        } catch {
          return unavailable("service_binding_unavailable");
        }
      },
      onTransportFailure: () => unavailable("service_binding_fetch_failed"),
      onTimeout: () => unavailable("service_binding_fetch_failed"),
    }).pipe(Effect.catchTag("LabConversationInputCheckUnavailable", Effect.succeed)),
  );
  if (verdict === null) return;
  if (verdict instanceof LabConversationInputCheckUnavailable) throw verdict;
  throw new Error(
    verdict === "invalid_conversation_input" ? labRejectedConversationInput : verdict,
  );
}

async function buildRawInstructionsLabRuntimeStartRequest({
  runId,
  startedAt,
  profile,
  connection,
  selection,
  agentInput,
  reasoningEffort,
  executionSettings: requestedSettings,
  startupExpiresAt,
  diagnosticsContext,
  checkInput,
}: Readonly<{
  runId: string;
  startedAt: number;
  profile: string;
  connection: RuntimeConnectionExchange;
  selection: unknown;
  agentInput: unknown;
  reasoningEffort: unknown;
  executionSettings: unknown;
  startupExpiresAt: number;
  deliveryTarget?: import("../../shared/contracts/runtimeDelivery.ts").RuntimeDeliveryTarget;
  diagnosticsContext: RuntimeDiagnosticsContext;
  checkInput: (check: ConversationInputCheck) => Promise<void>;
}>): Promise<RuntimeStartRequest> {
  const parsedSelection = conversationSelectionSchema.safeParse(selection);
  if (!parsedSelection.success) throw new Error("invalid_runtime_start_request");
  const selected = parsedSelection.data;
  const acceptedInput = z.json().parse(agentInput);
  const realtime = selected.execution.id === "realtime" && selected.execution.version === 1;
  // The page's execution settings belong to the selected execution, which reads them. A Realtime
  // Start without settings takes Lab's Realtime defaults; any other Start without settings
  // carries none.
  const settings = requestedSettings ?? (realtime ? defaultLabRealtimeSettings : undefined);
  const executionSettings = settings === undefined ? undefined : z.json().parse(settings);
  // Runtime's catalog decides whether the selection exists and accepts this input, and the
  // selected execution whether it can prepare these settings, before Lab dispatches its Start.
  await checkInput(
    executionSettings === undefined
      ? { selection: selected, agentInput: acceptedInput }
      : { selection: selected, agentInput: acceptedInput, executionSettings },
  );
  const execution = { agentInput: acceptedInput };

  const runtimeStartCandidate: RawInstructionsRuntimeStartCandidate = {
    runId,
    createdAt: startedAt,
    selection: selected,
    profile,
    connection,
    startupExpiresAt,
    execution,
    deliveryTarget: { integration: "lab", context: { runId } },
    diagnosticsContext,
  };

  if (reasoningEffort !== undefined) {
    runtimeStartCandidate.reasoningEffort = reasoningEffort;
  }

  if (executionSettings !== undefined) runtimeStartCandidate.executionSettings = executionSettings;

  const parsed = parseRuntimeStartRequest(runtimeStartCandidate);

  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  return parsed.value;
}

export async function handleLabConversationSelections(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response> {
  const runtime = getRuntimeWorkerResponse(request, env);
  if (!runtime.ok) return runtime.response;
  const result = await fetchRuntimeWorkerRequest(
    request,
    env,
    runtime.runtime,
    new Request(toRuntimeUrl(request, "/_runtime/conversation-selections"), {
      signal: request.signal,
    }),
  );
  return toBrowserRuntimeResponse(request, env, result.response);
}
