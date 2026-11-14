import { recoverRuntimeDiagnostics } from "../../shared/runtimeDiagnosticRecovery.ts";
import { appendLabRuntimeDiagnosticRecords } from "../persistence/labD1.ts";

import { promptLibrarySeed } from "../../../src/apps/lab/content/promptLibrary.ts";
import {
  createLabPrompt,
  fillEmptyLabPromptLibrary,
  listLabPrompts,
  updateLabPrompt,
} from "../persistence/labPromptsD1.ts";
import { jsonResponse, safeString } from "../../shared/http.ts";
import {
  appendRuntimeEvents,
  createLabRun,
  getLabDatabase,
  getLabRun,
  getLabStartRequest,
  getRunDiagnostics,
  labRunExists,
  listRuntimeEvents,
  listLabRuns,
  recordCompletionDiagnostics,
  recordLabRunSetupFailureEnd,
  recordProviderCall,
  recordSettingsSummary,
  recordSetupFailure,
  type LabRuntimeEventInput,
  type PromptProvenance,
} from "../persistence/labD1.ts";
import {
  readDiagnosticsEnvironment,
  type D1DatabaseCapability,
} from "../../shared/persistence/runDiagnosticsD1.ts";
import type { LabEnvironmentCapabilities } from "../types.ts";

type JsonObjectResult =
  | Readonly<{ ok: true; value: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false }>;

type LabDatabaseResult =
  | Readonly<{ ok: true; db: D1DatabaseCapability }>
  | Readonly<{ ok: false; response: Response }>;

type SetupFailure = Readonly<{
  errorText: string;
  failureKind: string;
  source: string;
  code?: string;
}>;

type SetupFailureRecordInput = {
  runId: string;
  errorText: string;
  failureKind: string;
  source: string;
  code?: string;
};

type CompletionDiagnosticsRecordInput = {
  runId: string;
  completionStatus: string;
  completionDebugText: string;
  completionReviewStatus?: string;
};

export async function handleLabStorageRoute(
  request: Request,
  env: LabEnvironmentCapabilities,
): Promise<Response | null> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] !== "_api") {
    return null;
  }

  const dbResult = getDbResponse(request, env);
  if (!dbResult.ok) {
    return dbResult.response;
  }

  const db = dbResult.db;

  if (segments[1] === "prompts" && segments.length === 2 && request.method === "GET") {
    try {
      const prompts = await listLabPrompts(db);
      if (prompts.length > 0) return jsonResponse(request, env, prompts);
      await fillEmptyLabPromptLibrary(db, promptLibrarySeed);
      return jsonResponse(request, env, await listLabPrompts(db));
    } catch {
      return jsonResponse(request, env, { error: "lab_prompts_unavailable" }, 500);
    }
  }

  if (segments[1] === "prompts" && segments.length === 2 && request.method === "POST") {
    const payload = await readJsonObject(request);
    if (
      !payload.ok ||
      typeof payload.value.name !== "string" ||
      typeof payload.value.content !== "string"
    )
      return jsonResponse(request, env, { error: "invalid_lab_prompt_request" }, 400);
    const name = payload.value.name.trim();
    if (name.length === 0 || name.length > 120 || name.includes("/") || name.includes("\\"))
      return jsonResponse(request, env, { error: "invalid_lab_prompt_name" }, 400);
    try {
      const prompt = await createLabPrompt(db, name, payload.value.content);
      return prompt === null
        ? jsonResponse(request, env, { error: "lab_prompt_name_taken" }, 409)
        : jsonResponse(request, env, prompt, 201);
    } catch {
      return jsonResponse(request, env, { error: "lab_prompt_save_failed" }, 500);
    }
  }

  if (segments[1] === "prompts" && segments.length === 3 && request.method === "PATCH") {
    const payload = await readJsonObject(request);
    if (!payload.ok || typeof payload.value.content !== "string")
      return jsonResponse(request, env, { error: "invalid_lab_prompt_request" }, 400);
    try {
      const prompt = await updateLabPrompt(
        db,
        decodeURIComponent(segments[2] ?? ""),
        payload.value.content,
      );
      return prompt === null
        ? jsonResponse(request, env, { error: "lab_prompt_not_found" }, 404)
        : jsonResponse(request, env, prompt);
    } catch {
      return jsonResponse(request, env, { error: "lab_prompt_save_failed" }, 500);
    }
  }

  if (segments[1] === "runs" && segments.length === 2) {
    if (request.method === "POST") {
      return handleCreateLabRun(request, env, db);
    }

    if (request.method === "GET") {
      return jsonResponse(request, env, await listLabRuns(db));
    }
  }

  if (segments[1] === "runs" && segments.length >= 3) {
    const runId = safeString(decodeURIComponent(segments[2] ?? ""), "");

    if (runId.length === 0) {
      return jsonResponse(request, env, { error: "missing_run_id" }, 400);
    }

    if (segments.length === 3 && request.method === "GET") {
      if (await labRunExists(db, runId))
        await recoverRuntimeDiagnostics({
          db,
          runtime: env.RUNTIME_WORKER,
          runId,
          signal: request.signal,
          persist: (records) => appendLabRuntimeDiagnosticRecords(db, runId, records),
        });
      const run = await getLabRun(db, runId);
      return run === null
        ? jsonResponse(request, env, { error: "lab_run_not_found" }, 404)
        : jsonResponse(request, env, run);
    }

    if (segments.length === 4 && segments[3] === "start-request" && request.method === "GET") {
      try {
        const startRequest = await getLabStartRequest(db, runId);
        return startRequest === null
          ? jsonResponse(request, env, { error: "lab_start_request_not_found" }, 404)
          : jsonResponse(request, env, startRequest);
      } catch {
        return jsonResponse(request, env, { error: "lab_start_request_unavailable" }, 500);
      }
    }

    if (segments.length === 4 && segments[3] === "setup-failure" && request.method === "PATCH") {
      return handleRecordLabRunSetupFailure(request, env, db, runId);
    }

    if (segments.length === 4 && segments[3] === "diagnostics") {
      if (request.method === "GET") {
        const diagnostics = await getRunDiagnostics(db, runId);
        return diagnostics === null
          ? jsonResponse(request, env, { error: "lab_run_not_found" }, 404)
          : jsonResponse(request, env, diagnostics);
      }

      if (request.method === "PATCH") {
        return handlePatchDiagnostics(request, env, db, runId);
      }
    }

    if (segments.length === 4 && segments[3] === "runtime-events") {
      if (request.method === "GET") {
        if (!(await labRunExists(db, runId))) {
          return jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
        }

        if (await labRunExists(db, runId))
          await recoverRuntimeDiagnostics({
            db,
            runtime: env.RUNTIME_WORKER,
            runId,
            signal: request.signal,
            persist: (records) => appendLabRuntimeDiagnosticRecords(db, runId, records),
          });
        return jsonResponse(request, env, await listRuntimeEvents(db, runId));
      }

      if (request.method === "POST") {
        return handleAppendRuntimeEvents(request, env, db, runId);
      }
    }
  }

  return null;
}

async function handleCreateLabRun(
  request: Request,
  env: LabEnvironmentCapabilities,
  db: D1DatabaseCapability,
): Promise<Response> {
  const payload = await readOptionalJsonObject(request);

  if (!payload.ok) {
    return jsonResponse(request, env, { error: "invalid_lab_run_request" }, 400);
  }

  const promptProvenance = payload.value.promptProvenance;

  if (promptProvenance !== undefined && !isPromptProvenance(promptProvenance)) {
    return jsonResponse(request, env, { error: "invalid_prompt_provenance" }, 400);
  }

  return jsonResponse(
    request,
    env,
    await createLabRun(db, {
      promptProvenance,
      diagnosticsEnvironment: readDiagnosticsEnvironment(env),
    }),
    201,
  );
}

async function handleRecordLabRunSetupFailure(
  request: Request,
  env: LabEnvironmentCapabilities,
  db: D1DatabaseCapability,
  runId: string,
): Promise<Response> {
  const payload = await readJsonObject(request);

  if (
    !payload.ok ||
    typeof payload.value.endedAt !== "number" ||
    !Number.isFinite(payload.value.endedAt)
  ) {
    return jsonResponse(request, env, { error: "invalid_lab_run_setup_failure_request" }, 400);
  }

  const updated = await recordLabRunSetupFailureEnd(db, {
    runId,
    endedAt: payload.value.endedAt,
  });

  return updated
    ? jsonResponse(request, env, { ok: true })
    : jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
}

async function handlePatchDiagnostics(
  request: Request,
  env: LabEnvironmentCapabilities,
  db: D1DatabaseCapability,
  runId: string,
): Promise<Response> {
  const payload = await readJsonObject(request);

  if (!payload.ok) {
    return jsonResponse(request, env, { error: "invalid_diagnostics_request" }, 400);
  }

  if (!(await labRunExists(db, runId))) {
    return jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
  }

  const value = payload.value;

  if (value.sessionId !== undefined) {
    if (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0) {
      return jsonResponse(request, env, { error: "invalid_session_id" }, 400);
    }

    await recordProviderCall(db, {
      runId,
      sessionId: value.sessionId.trim(),
    });
  }

  if (value.setupFailure !== undefined) {
    if (!isSetupFailure(value.setupFailure)) {
      return jsonResponse(request, env, { error: "invalid_setup_failure" }, 400);
    }

    const setupFailure: SetupFailureRecordInput = {
      runId,
      errorText: value.setupFailure.errorText,
      failureKind: value.setupFailure.failureKind,
      source: value.setupFailure.source,
    };
    if (value.setupFailure.code !== undefined) setupFailure.code = value.setupFailure.code;
    await recordSetupFailure(db, setupFailure);
  }

  if (value.settingsSummary !== undefined) {
    if (!isRecord(value.settingsSummary)) {
      return jsonResponse(request, env, { error: "invalid_settings_summary" }, 400);
    }

    await recordSettingsSummary(db, {
      runId,
      settingsSummary: value.settingsSummary,
    });
  }

  if (value.completionStatus !== undefined || value.completionDebugText !== undefined) {
    if (
      typeof value.completionStatus !== "string" ||
      typeof value.completionDebugText !== "string" ||
      (value.completionReviewStatus !== undefined &&
        typeof value.completionReviewStatus !== "string")
    ) {
      return jsonResponse(request, env, { error: "invalid_completion_diagnostics" }, 400);
    }

    const completionDiagnostics: CompletionDiagnosticsRecordInput = {
      runId,
      completionStatus: value.completionStatus,
      completionDebugText: value.completionDebugText,
    };
    if (value.completionReviewStatus !== undefined) {
      completionDiagnostics.completionReviewStatus = value.completionReviewStatus;
    }
    await recordCompletionDiagnostics(db, completionDiagnostics);
  }

  return jsonResponse(request, env, { ok: true });
}

async function handleAppendRuntimeEvents(
  request: Request,
  env: LabEnvironmentCapabilities,
  db: D1DatabaseCapability,
  runId: string,
): Promise<Response> {
  const payload = await readJsonObject(request);

  if (
    !payload.ok ||
    !Array.isArray(payload.value.records) ||
    !payload.value.records.every(isRuntimeEventRecord) ||
    payload.value.records.some(isReservedLabDiagnostic)
  ) {
    return jsonResponse(request, env, { error: "invalid_runtime_event_request" }, 400);
  }

  if (!(await labRunExists(db, runId))) {
    return jsonResponse(request, env, { error: "lab_run_not_found" }, 404);
  }

  return jsonResponse(
    request,
    env,
    await appendRuntimeEvents(db, {
      runId,
      records: payload.value.records,
    }),
    201,
  );
}

function isReservedLabDiagnostic(record: LabRuntimeEventInput): boolean {
  return (
    // The Realtime kit's own records are Runtime's too, under its own name since #982.
    /^(?:runtime|realtime|conversation|execution)\./u.test(record.type) ||
    record.type === "lab.closing_review" ||
    "recordId" in record ||
    "runtimeRecord" in record
  );
}

function getDbResponse(request: Request, env: LabEnvironmentCapabilities): LabDatabaseResult {
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

async function readOptionalJsonObject(request: Request): Promise<JsonObjectResult> {
  if (request.headers.get("Content-Length") === "0" || request.body === null) {
    return {
      ok: true,
      value: {},
    };
  }

  return readJsonObject(request);
}

async function readJsonObject(request: Request): Promise<JsonObjectResult> {
  try {
    const value = await request.json();

    if (!isRecord(value)) {
      return {
        ok: false,
      };
    }

    return {
      ok: true,
      value,
    };
  } catch {
    return {
      ok: false,
    };
  }
}

function isRecord<Value>(value: Value): value is Value & Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPromptProvenance<Value>(value: Value): value is Value & PromptProvenance {
  return (
    isRecord(value) &&
    typeof value.promptId === "string" &&
    (value.promptFileName === undefined || typeof value.promptFileName === "string") &&
    typeof value.contentHash === "string"
  );
}

function isSetupFailure<Value>(value: Value): value is Value & SetupFailure {
  return (
    isRecord(value) &&
    typeof value.errorText === "string" &&
    value.errorText.length > 0 &&
    isSetupFailureKind(value.failureKind) &&
    isDiagnosticSource(value.source) &&
    (value.code === undefined || typeof value.code === "string")
  );
}

function isRuntimeEventRecord<Value>(value: Value): value is Value & LabRuntimeEventInput {
  return (
    isRecord(value) &&
    (value.observedAt === undefined ||
      (typeof value.observedAt === "number" && Number.isFinite(value.observedAt))) &&
    (value.sequence === undefined ||
      (typeof value.sequence === "number" && Number.isFinite(value.sequence))) &&
    (value.elapsedMs === undefined ||
      (typeof value.elapsedMs === "number" && Number.isFinite(value.elapsedMs))) &&
    typeof value.type === "string" &&
    (typeof value.payloadJson === "string" || isRecord(value.payload))
  );
}

function isSetupFailureKind<Value>(value: Value): value is Value & string {
  return (
    value === "browser_media" ||
    value === "browser_peer" ||
    value === "provider_signaling" ||
    value === "runtime_worker_unavailable" ||
    value === "session_setup" ||
    value === "browser_runtime_event_stream"
  );
}

function isDiagnosticSource<Value>(value: Value): value is Value & string {
  return (
    value === "browser" ||
    value === "lab_worker" ||
    value === "runtime_controller" ||
    value === "provider"
  );
}
