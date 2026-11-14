import { appendRuntimeDiagnosticRecords } from "../../shared/persistence/runDiagnosticsD1.ts";
import type { RuntimeDiagnosticRecord } from "../../shared/contracts/runtimeDiagnostics.ts";
import { applicationStartupBudgetMs as labStartupBudgetMs } from "../../shared/contracts/interviewLifecyclePolicy.ts";
import { z } from "zod";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { withoutUndefined } from "../../shared/http.ts";
import {
  appendRunDiagnosticEvents,
  ensureRunDiagnosticSummary,
  getRunDiagnosticSummary,
  listRunDiagnosticEvents,
  readDiagnosticsEnvironment,
  updateRunDiagnosticSummary,
  type D1DatabaseCapability,
  type D1RunResultCapability,
  type RunDiagnosticSummaryRow,
} from "../../shared/persistence/runDiagnosticsD1.ts";
import {
  isRuntimeEndReason,
  isRuntimeTerminalOutcome,
  isRuntimeTranscriptPayload,
  type CompletionReceipt,
  type RuntimeCompletion,
  type RuntimeEndReason,
  type RuntimeTerminalOutcome,
  type RuntimeTranscriptSnapshot,
  type RuntimeTranscriptSnapshotRef,
  type RuntimeTranscriptPayload,
  type SnapshotReceipt,
} from "../../shared/runtimeControllerCallback.ts";
import {
  canonicalizeRuntimeTranscript,
  computeRuntimeTranscriptDigest,
  matchesTranscriptSnapshotIdentity,
} from "../../shared/runtimeTranscriptSnapshot.ts";
import { getLabTerminalResult } from "./labTerminalResults.ts";
import { getLabClosingDiagnostic, type LabClosingDiagnostic } from "./labClosingDiagnostics.ts";
import type { RuntimeTerminalResult } from "../../shared/contracts/runtimeTerminalResult.ts";
import { conversationSelectionSchema } from "../../shared/contracts/conversationSelection.ts";
import type { LabEnvironmentCapabilities } from "../types.ts";

const emptyTranscriptJson = JSON.stringify({ turns: [] });
const labRunListLimit = 100;
const runtimeEventListLimit = 2_000;

export type PromptProvenance = Readonly<{
  promptId: string;
  promptFileName?: string;
  contentHash: string;
}>;

export type LabRunSummary = Readonly<{
  runId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: RuntimeTerminalOutcome;
  endReason?: RuntimeEndReason;
  transcriptTurnCount: number;
}>;

export type LabRun = LabRunSummary &
  Readonly<{
    transcript: RuntimeTranscriptPayload;
    executionModel?: string;
    maxOutputTokens?: number | "inf";
    responseUsage: readonly LabResponseUsage[];
    terminalResult?: RuntimeTerminalResult;
    closingDiagnostic?: LabClosingDiagnostic;
  }>;

export type LabResponseUsage = Readonly<{
  responseId: string;
  outputTokens: number;
  model?: string;
  answerTurnNumber?: number;
}>;

export type LabRuntimeEventInput = Readonly<{
  observedAt?: number | undefined;
  sequence?: number | undefined;
  elapsedMs?: number | undefined;
  type: string;
  payloadJson?: string;
  payload?: Readonly<Record<string, unknown>>;
}>;

type CreateLabRunOptions = Readonly<{
  startAttempt?: Readonly<{ attemptId: string; requestJson: string }>;
  promptProvenance?: unknown;
  now?: () => number;
  diagnosticsEnvironment?: string;
}>;

type LabTranscriptSnapshotRow = Readonly<{
  endedAt: number | null;
  outcome: string | null;
  endReason: string | null;
  runtimeCompletionJson: string | null;
  transcriptJson: string;
  storedSnapshot: RuntimeTranscriptSnapshotRef | null;
}>;

type LabRunRow = Readonly<{
  runId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: RuntimeTerminalOutcome | null;
  endReason: RuntimeEndReason | null;
  transcript: RuntimeTranscriptPayload;
  executionModel: string | null;
  maxOutputTokens: number | "inf" | null;
}>;

type LabDiagnosticsRow = Readonly<{
  runId: string;
  startedAt: number;
  endedAt: number | null;
  promptProvenance: StoredJsonValue | null;
}>;

type LabDiagnosticSummaryInput = {
  runId: string;
  surface: string;
  environment?: string;
  appResourceKind: string;
  appResourceId: string;
  startedAt: number;
  endedAt?: number;
  promptProvenance?: unknown;
};

type LabRunSummaryDraft = {
  runId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: RuntimeTerminalOutcome;
  endReason?: RuntimeEndReason;
  transcriptTurnCount: number;
};

type OptionalObservedAt = Readonly<{ observedAt?: number }>;

const storedJsonValueSchema = z.json();
const storedTranscriptSchema = z.custom<RuntimeTranscriptPayload>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(Object.getOwnPropertyDescriptor(value, "turns")?.value),
);

type StoredJsonValue = z.infer<typeof storedJsonValueSchema>;
const labResponseUsageEventSchema = z.looseObject({
  providerEventType: z.literal("response.done"),
  responseId: z.string().trim().min(1),
  response: z.looseObject({
    outputTokens: z.number().int().safe().nonnegative().optional(),
    output: z.array(z.looseObject({ type: z.string(), role: z.string().optional() })).optional(),
  }),
});

/** Cascade's account of one output's model response, recorded by its execution. */
const labCascadeModelUsageSchema = z.looseObject({
  outputId: z.string().trim().min(1),
  outputTokens: z.number().int().safe().nonnegative(),
});

const labRunRowBoundary = boundary({
  schema: z.object({
    run_id: z.unknown(),
    started_at: z.unknown(),
    ended_at: z.unknown(),
    outcome: z.unknown(),
    end_reason: z.unknown(),
    transcript_json: z.unknown(),
    execution_model: z.unknown().optional(),
    max_output_tokens: z.string().nullable().optional(),
  }),
  convert: (row): LabRunRow => ({
    runId: requireString(row.run_id),
    startedAt: requireNumber(row.started_at),
    endedAt: requireNullableNumber(row.ended_at),
    outcome: requireNullableLabRunOutcome(row.outcome),
    endReason: requireNullableLabRunEndReason(row.end_reason),
    transcript: parseTranscript(row.transcript_json),
    executionModel: readNullableString(row.execution_model),
    maxOutputTokens: readMaxOutputTokens(row.max_output_tokens),
  }),
});

const labDiagnosticsRowBoundary = boundary({
  schema: z.object({
    run_id: z.unknown(),
    started_at: z.unknown(),
    ended_at: z.unknown(),
    prompt_provenance_json: z.unknown(),
  }),
  convert: (row): LabDiagnosticsRow => ({
    runId: requireString(row.run_id),
    startedAt: requireNumber(row.started_at),
    endedAt: requireNullableNumber(row.ended_at),
    promptProvenance: parseStoredJson(row.prompt_provenance_json),
  }),
});

const labTranscriptSnapshotRowBoundary = boundary({
  schema: z.object({
    ended_at: z.unknown(),
    outcome: z.unknown(),
    end_reason: z.unknown(),
    runtime_completion_json: z.unknown(),
    transcript_json: z.unknown(),
    transcript_revision: z.unknown(),
    transcript_digest: z.unknown(),
    transcript_turn_count: z.unknown(),
  }),
  convert: (row): LabTranscriptSnapshotRow => ({
    endedAt: requireNullableNumber(row.ended_at),
    outcome: readNullableString(row.outcome),
    endReason: readNullableString(row.end_reason),
    runtimeCompletionJson: readNullableString(row.runtime_completion_json),
    transcriptJson: requireString(row.transcript_json),
    storedSnapshot: readStoredTranscriptSnapshot(
      row.transcript_revision,
      row.transcript_digest,
      row.transcript_turn_count,
    ),
  }),
});

export function getLabDatabase(
  env: Pick<LabEnvironmentCapabilities, "LAB_DB">,
): D1DatabaseCapability {
  if (env.LAB_DB === undefined) {
    throw new Error("missing_lab_database");
  }

  return env.LAB_DB;
}

const readLabStartAttempt = boundary({
  schema: z
    .unknown()
    .refine(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, "started_at") &&
        Object.hasOwn(value, "start_request_json"),
    )
    .pipe(
      z.strictObject({
        started_at: z.number().int().safe().nonnegative(),
        start_request_json: z.string(),
      }),
    ),
  convert: (row) => row,
});

export async function createLabRun(
  db: D1DatabaseCapability,
  {
    promptProvenance,
    now = Date.now,
    diagnosticsEnvironment,
    startAttempt,
  }: CreateLabRunOptions = {},
): Promise<Readonly<{ runId: string; startedAt: number }>> {
  const runId = `lab_${startAttempt?.attemptId ?? crypto.randomUUID()}`;
  let startedAt = now();
  const emptyTranscriptDigest = await computeRuntimeTranscriptDigest({ turns: [] });

  await db
    .prepare(
      `INSERT INTO lab_runs (
        run_id,
        started_at,
        prompt_provenance_json,
        transcript_json,
        transcript_revision,
        transcript_digest,
        transcript_turn_count,
        startup_expires_at,
        start_request_json
      ) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?) ON CONFLICT(run_id) DO NOTHING`,
    )
    .bind(
      runId,
      startedAt,
      promptProvenance === undefined ? null : JSON.stringify(promptProvenance),
      emptyTranscriptJson,
      emptyTranscriptDigest,
      startedAt + labStartupBudgetMs,
      startAttempt?.requestJson ?? null,
    )
    .run();

  if (startAttempt !== undefined) {
    const row = await db
      .prepare("SELECT started_at, start_request_json FROM lab_runs WHERE run_id = ?")
      .bind(runId)
      .first();
    const retained = readLabStartAttempt(row);
    if (retained.start_request_json !== startAttempt.requestJson)
      throw new Error("lab_start_attempt_conflict");
    startedAt = retained.started_at;
  }

  const diagnosticSummary: LabDiagnosticSummaryInput = {
    runId,
    surface: "lab",
    appResourceKind: "lab_run",
    appResourceId: runId,
    startedAt,
  };
  if (diagnosticsEnvironment !== undefined) {
    diagnosticSummary.environment = diagnosticsEnvironment;
  }
  if (promptProvenance !== undefined) {
    diagnosticSummary.promptProvenance = promptProvenance;
  }
  await ensureRunDiagnosticSummary(db, diagnosticSummary);

  return {
    runId,
    startedAt,
  };
}

export async function persistLabRunTranscriptSnapshot(
  db: D1DatabaseCapability,
  { runId, snapshot }: Readonly<{ runId: string; snapshot: RuntimeTranscriptSnapshot }>,
): Promise<SnapshotReceipt | null> {
  await assertLabSnapshotDigest(snapshot);
  const canonicalTranscriptJson = canonicalizeRuntimeTranscript(snapshot.transcript);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await getLabTranscriptSnapshotRow(db, runId);

    if (existing === null) {
      return null;
    }

    if (existing.storedSnapshot === null) {
      return labSnapshotReceipt("conflict", null, false);
    }

    const requestedReference = {
      revision: snapshot.revision,
      digest: snapshot.digest,
      turnCount: snapshot.turnCount,
    } satisfies RuntimeTranscriptSnapshotRef;
    const requestedMatches = matchesTranscriptSnapshotIdentity(
      existing.storedSnapshot,
      requestedReference,
    );

    if (existing.endedAt !== null) {
      return labSnapshotReceipt(
        requestedMatches &&
          matchesCanonicalTranscriptJson(existing.transcriptJson, canonicalTranscriptJson)
          ? "idempotent"
          : "sealed",
        existing.storedSnapshot,
        requestedMatches,
      );
    }

    if (snapshot.revision < existing.storedSnapshot.revision) {
      return labSnapshotReceipt("stale", existing.storedSnapshot, false);
    }

    if (snapshot.revision === existing.storedSnapshot.revision) {
      return labSnapshotReceipt(
        requestedMatches &&
          matchesCanonicalTranscriptJson(existing.transcriptJson, canonicalTranscriptJson)
          ? "idempotent"
          : "conflict",
        existing.storedSnapshot,
        requestedMatches,
      );
    }

    const result = await db
      .prepare(
        `UPDATE lab_runs
         SET transcript_json = ?,
             transcript_revision = ?,
             transcript_digest = ?,
             transcript_turn_count = ?
         WHERE run_id = ?
           AND ended_at IS NULL
           AND transcript_revision IS NOT NULL
           AND transcript_digest IS NOT NULL
           AND transcript_turn_count IS NOT NULL
           AND transcript_revision < ?`,
      )
      .bind(
        canonicalTranscriptJson,
        snapshot.revision,
        snapshot.digest,
        snapshot.turnCount,
        runId,
        snapshot.revision,
      )
      .run();

    if (getChangeCount(result) > 0) {
      const stored = await getLabTranscriptSnapshotRow(db, runId);
      return stored === null
        ? null
        : labSnapshotReceiptAfterWrite(requestedReference, stored.storedSnapshot);
    }
  }

  const stored = await getLabTranscriptSnapshotRow(db, runId);
  return stored === null ? null : labSnapshotReceipt("conflict", stored.storedSnapshot, false);
}

export async function completeLabRunFromSnapshot(
  db: D1DatabaseCapability,
  { completion }: Readonly<{ completion: RuntimeCompletion }>,
): Promise<CompletionReceipt | null> {
  const requestedReference = completion.transcriptSnapshot;
  const runtimeCompletionJson = serializeRuntimeCompletion(completion);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await getLabTranscriptSnapshotRow(db, completion.runId);

    if (existing === null) {
      return null;
    }

    const requestedMatches = matchesTranscriptSnapshotIdentity(
      existing.storedSnapshot,
      requestedReference,
    );

    if (!requestedMatches) {
      return labCompletionReceipt("snapshot_mismatch", existing.storedSnapshot, false);
    }

    if (existing.endedAt !== null) {
      const terminalMatches = existing.runtimeCompletionJson === runtimeCompletionJson;

      return labCompletionReceipt(
        terminalMatches ? "idempotent" : "completion_conflict",
        existing.storedSnapshot,
        true,
      );
    }

    const result = await db
      .prepare(
        `UPDATE lab_runs
         SET ended_at = ?,
             outcome = ?,
             end_reason = ?,
             runtime_completion_json = ?,
             completion_transcript_revision = ?,
             completion_transcript_digest = ?,
             completion_transcript_turn_count = ?
         WHERE run_id = ?
           AND ended_at IS NULL
           AND transcript_revision = ?
           AND transcript_digest = ?
           AND transcript_turn_count = ?`,
      )
      .bind(
        completion.endedAt,
        completion.outcome,
        completion.endReason,
        runtimeCompletionJson,
        requestedReference.revision,
        requestedReference.digest,
        requestedReference.turnCount,
        completion.runId,
        requestedReference.revision,
        requestedReference.digest,
        requestedReference.turnCount,
      )
      .run();

    if (getChangeCount(result) > 0) {
      const stored = await getLabTranscriptSnapshotRow(db, completion.runId);
      return stored === null
        ? null
        : labCompletionReceipt("completed", stored.storedSnapshot, true);
    }
  }

  const stored = await getLabTranscriptSnapshotRow(db, completion.runId);
  return stored === null
    ? null
    : labCompletionReceipt("completion_conflict", stored.storedSnapshot, false);
}

export async function recordLabRunSetupFailureEnd(
  db: D1DatabaseCapability,
  { runId, endedAt }: Readonly<{ runId: string; endedAt: number }>,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE lab_runs
       SET ended_at = ?, outcome = 'failed', end_reason = 'runtime_failed'
       WHERE run_id = ?
         AND ended_at IS NULL
         AND runtime_completion_json IS NULL
         AND terminal_result_json IS NULL
         AND runtime_dispatch_intent_at IS NULL
         AND transcript_revision = 0
         AND transcript_turn_count = 0`,
    )
    .bind(endedAt, runId)
    .run();

  if (getChangeCount(result) > 0) {
    await ensureLabRunDiagnosticSummary(db, runId);
    await updateRunDiagnosticSummary(db, { runId, endedAt });
  }

  return getChangeCount(result) > 0;
}

export async function listLabRuns(db: D1DatabaseCapability): Promise<LabRunSummary[]> {
  const result = await db
    .prepare(
      `SELECT
        run_id,
        started_at,
        ended_at,
        outcome,
        end_reason,
        transcript_json
      FROM lab_runs
      ORDER BY started_at DESC
      LIMIT ?`,
    )
    .bind(labRunListLimit)
    .all();

  return result.results.map((row) => toLabRunListItem(labRunRowBoundary(row)));
}

export async function getLabRun(db: D1DatabaseCapability, runId: string): Promise<LabRun | null> {
  const row = await db
    .prepare(
      `SELECT
        run_id,
        started_at,
        ended_at,
        outcome,
        end_reason,
        transcript_json,
        execution_model,
        max_output_tokens
      FROM lab_runs
      WHERE run_id = ?`,
    )
    .bind(runId)
    .first();

  if (row === null) return null;
  const usageRows = await db
    .prepare(
      `SELECT response_id, output_tokens, assistant_message FROM lab_response_usage WHERE run_id = ? ORDER BY rowid ASC`,
    )
    .bind(runId)
    .all()
    .catch(() => ({ results: [] }));
  const run = labRunRowBoundary(row);
  let detail = toLabRunDetail(run, []);
  try {
    detail = toLabRunDetail(run, usageRows.results);
  } catch {
    /* Optional usage evidence is unavailable. */
  }
  const terminalResult = await getLabTerminalResult(db, runId);
  const closingDiagnostic = await getLabClosingDiagnostic(db, runId);
  const result = terminalResult === null ? detail : { ...detail, terminalResult };
  return closingDiagnostic === undefined ? result : { ...result, closingDiagnostic };
}

const savedStartRequestRow = boundary({
  schema: z.strictObject({ start_request_json: z.string().nullable() }),
  convert: (row) => row.start_request_json,
});

/**
 * The caller's saved Start request without its connection exchange, attempt identity or prompt
 * provenance: the selection, inputs and execution settings the Run was admitted with.
 */
const savedStartRequest = boundary({
  schema: z.object({
    profile: z.string().min(1),
    selection: conversationSelectionSchema,
    agentInput: z.json(),
    reasoningEffort: z.json().optional(),
    executionSettings: z.json().optional(),
  }),
  convert: (request) => request,
});

export type LabStartRequest = ReturnType<typeof savedStartRequest>;

export async function getLabStartRequest(
  db: D1DatabaseCapability,
  runId: string,
): Promise<LabStartRequest | null> {
  const row = await db
    .prepare("SELECT start_request_json FROM lab_runs WHERE run_id = ?")
    .bind(runId)
    .first();
  if (row === null) return null;
  const saved = savedStartRequestRow(row);
  return saved === null ? null : savedStartRequest(JSON.parse(saved));
}

export async function labRunExists(db: D1DatabaseCapability, runId: string): Promise<boolean> {
  const row = await db.prepare("SELECT run_id FROM lab_runs WHERE run_id = ?").bind(runId).first();

  return row !== null;
}

export async function recordProviderCall(
  db: D1DatabaseCapability,
  {
    runId,
    sessionId,
    upstreamRequestId,
    observedAt,
  }: Readonly<{
    runId: string;
    sessionId: string;
    upstreamRequestId?: string;
    observedAt?: number;
  }>,
): Promise<void> {
  await ensureLabRunDiagnosticSummary(db, runId);
  await updateRunDiagnosticSummary(db, {
    runId,
    sessionId,
  });

  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "realtime.call_recorded",
    payload: withoutUndefined({
      source: "lab_worker",
      phase: "setup",
      sessionId,
      upstreamRequestId,
    }),
  });
}

export async function recordSetupFailure(
  db: D1DatabaseCapability,
  {
    runId,
    errorText,
    failureKind = "provider_signaling",
    source = "lab_worker",
    code,
    observedAt,
  }: Readonly<{
    runId: string;
    errorText: string;
    failureKind?: string;
    source?: string;
    code?: string;
    observedAt?: number;
  }>,
): Promise<void> {
  await ensureLabRunDiagnosticSummary(db, runId);
  const setupFailure = withoutUndefined({
    failureKind,
    source,
    errorText,
    code,
  });
  await updateRunDiagnosticSummary(db, {
    runId,
    setupFailure,
  });

  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "runtime.setup_failed",
    payload: setupFailure,
  });
}

export async function recordSettingsSummary(
  db: D1DatabaseCapability,
  {
    runId,
    settingsSummary,
  }: Readonly<{ runId: string; settingsSummary: Readonly<Record<string, unknown>> }>,
): Promise<void> {
  await ensureLabRunDiagnosticSummary(db, runId);
  await updateRunDiagnosticSummary(db, {
    runId,
    settingsSummary,
  });
  const model = settingsSummary.model;
  const cap = settingsSummary.maxOutputTokens;
  if (
    typeof model === "string" &&
    (cap === "inf" || (typeof cap === "number" && Number.isSafeInteger(cap)))
  ) {
    await db
      .prepare(`UPDATE lab_runs SET execution_model = ?, max_output_tokens = ? WHERE run_id = ?`)
      .bind(model, String(cap), runId)
      .run();
  }
}

export async function recordCompletionDiagnostics(
  db: D1DatabaseCapability,
  {
    runId,
    completionStatus,
    completionReviewStatus,
    completionDebugText,
  }: Readonly<{
    runId: string;
    completionStatus: string;
    completionReviewStatus?: string;
    completionDebugText: string;
  }>,
): Promise<void> {
  await ensureLabRunDiagnosticSummary(db, runId);
  await updateRunDiagnosticSummary(db, {
    runId,
    completionStatus,
    completionReviewStatus: completionReviewStatus ?? null,
    completionDebugText,
  });
}

export async function getRunDiagnostics(
  db: D1DatabaseCapability,
  runId: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  const row = await db
    .prepare(
      `SELECT
        run_id,
        started_at,
        ended_at,
        prompt_provenance_json
      FROM lab_runs
      WHERE run_id = ?`,
    )
    .bind(runId)
    .first();

  if (row === null) {
    return null;
  }

  return toRuntimeRunDiagnostics(
    labDiagnosticsRowBoundary(row),
    await getRunDiagnosticSummary(db, runId),
  );
}

export async function appendRuntimeEvents(
  db: D1DatabaseCapability,
  { runId, records }: Readonly<{ runId: string; records: readonly LabRuntimeEventInput[] }>,
): Promise<Readonly<{ stored: true; reason: "lab"; storedCount: number }>> {
  if (records.length === 0) {
    return {
      stored: true,
      reason: "lab",
      storedCount: 0,
    };
  }

  await ensureLabRunDiagnosticSummary(db, runId);
  await appendRunDiagnosticEvents(db, {
    runId,
    records,
  });

  return {
    stored: true,
    reason: "lab",
    storedCount: records.length,
  };
}

export async function appendLabRuntimeDiagnosticRecords(
  db: D1DatabaseCapability,
  runId: string,
  records: readonly RuntimeDiagnosticRecord[],
): Promise<void> {
  await ensureLabRunDiagnosticSummary(db, runId);
  await appendRuntimeDiagnosticRecords(db, runId, records);
  await projectLabRuntimeDiagnostics(db, runId, records);
}
async function projectLabRuntimeDiagnostics(
  db: D1DatabaseCapability,
  runId: string,
  records: readonly RuntimeDiagnosticRecord[],
): Promise<void> {
  for (const record of records) {
    if (record.type === "cascade.model_usage") {
      // A Cascade output is one model response; its spoken text is not known from usage.
      const parsed = labCascadeModelUsageSchema.safeParse(parseStoredJson(record.payloadJson));
      if (!parsed.success) continue;
      await db
        .prepare(`INSERT INTO lab_response_usage (run_id, response_id, output_tokens, assistant_message)
        VALUES (?, ?, ?, 0) ON CONFLICT(run_id, response_id) DO UPDATE SET
          output_tokens = excluded.output_tokens`)
        .bind(runId, parsed.data.outputId, parsed.data.outputTokens)
        .run();
      continue;
    }
    if (record.type !== "realtime.provider_event_observed") continue;
    const payload = parseStoredJson(record.payloadJson);
    const parsed = labResponseUsageEventSchema.safeParse(payload);
    if (!parsed.success) continue;
    const {
      responseId,
      response: { outputTokens, output },
    } = parsed.data;
    const assistantMessage =
      output?.length === 1 && output[0]?.type === "message" && output[0].role === "assistant";
    await db
      .prepare(`INSERT INTO lab_response_usage (run_id, response_id, output_tokens, assistant_message)
      VALUES (?, ?, ?, ?) ON CONFLICT(run_id, response_id) DO UPDATE SET
        output_tokens = COALESCE(excluded.output_tokens, lab_response_usage.output_tokens),
        assistant_message = MAX(lab_response_usage.assistant_message, excluded.assistant_message)`)
      .bind(runId, responseId, outputTokens ?? null, assistantMessage ? 1 : 0)
      .run();
  }
}

export async function appendRuntimeEvent(
  db: D1DatabaseCapability,
  request: LabRuntimeEventInput & Readonly<{ runId: string }>,
): Promise<Readonly<{ stored: true; reason: "lab"; storedCount: number }>> {
  return appendRuntimeEvents(db, {
    runId: request.runId,
    records: [request],
  });
}

export async function listRuntimeEvents(db: D1DatabaseCapability, runId: string) {
  return listRunDiagnosticEvents(db, runId, runtimeEventListLimit);
}

export async function recordLiveReached(
  db: D1DatabaseCapability,
  {
    runId,
    source = "runtime_controller",
    observedAt,
  }: Readonly<{ runId: string; source?: string }> & OptionalObservedAt,
): Promise<void> {
  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "runtime.live_reached",
    payload: {
      source,
    },
  });
}

export async function recordLiveDegradation(
  db: D1DatabaseCapability,
  {
    runId,
    degradationKind,
    source,
    errorText,
    code,
    observedAt,
  }: Readonly<{
    runId: string;
    degradationKind: string;
    source: string;
    errorText?: string;
    code?: string;
  }> &
    OptionalObservedAt,
): Promise<void> {
  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "runtime.live_degraded",
    payload: withoutUndefined({
      source,
      degradationKind,
      errorText,
      code,
    }),
  });
}

export async function recordSidebandClosed(
  db: D1DatabaseCapability,
  {
    runId,
    source = "runtime_controller",
    reason,
    eventCount,
    observedAt,
  }: Readonly<{ runId: string; source?: string; reason?: string; eventCount?: number }> &
    OptionalObservedAt,
): Promise<void> {
  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "realtime.sideband_closed",
    payload: withoutUndefined({
      source,
      reason,
      eventCount,
    }),
  });
}

export async function recordEndingStarted(
  db: D1DatabaseCapability,
  {
    runId,
    endReason,
    trigger,
    source = "runtime_controller",
    observedAt,
  }: Readonly<{ runId: string; endReason?: string; trigger?: string; source?: string }> &
    OptionalObservedAt,
): Promise<void> {
  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "runtime.ending_started",
    payload: withoutUndefined({
      source,
      endReason,
      trigger,
    }),
  });
}

export async function recordFinalTurnFlushFinished(
  db: D1DatabaseCapability,
  {
    runId,
    source = "browser",
    status,
    inputCommitSent,
    completionReviewStatus,
    debugText,
    observedAt,
  }: Readonly<{
    runId: string;
    source?: string;
    status: string;
    inputCommitSent?: boolean;
    completionReviewStatus?: string;
    debugText?: string;
  }> &
    OptionalObservedAt,
): Promise<void> {
  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "runtime.final_turn_flush_finished",
    payload: withoutUndefined({
      source,
      status,
      inputCommitSent,
      completionReviewStatus,
      debugText,
    }),
  });
}

export async function recordAppEndStatePersisted(
  db: D1DatabaseCapability,
  {
    runId,
    source = "lab_worker",
    outcome,
    endReason,
    observedAt,
  }: Readonly<{
    runId: string;
    source?: string;
    outcome: RuntimeTerminalOutcome;
    endReason: RuntimeEndReason;
  }> &
    OptionalObservedAt,
): Promise<void> {
  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "runtime.app_end_state_persisted",
    payload: withoutUndefined({
      source,
      outcome,
      endReason,
    }),
  });
}

export async function recordAppEndStatePersistFailed(
  db: D1DatabaseCapability,
  {
    runId,
    source = "lab_worker",
    errorText,
    code,
    observedAt,
  }: Readonly<{ runId: string; source?: string; errorText: string; code?: string }> &
    OptionalObservedAt,
): Promise<void> {
  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "runtime.app_end_state_persist_failed",
    payload: withoutUndefined({
      source,
      errorText,
      code,
    }),
  });
}

export async function recordProviderCloseFinished(
  db: D1DatabaseCapability,
  {
    runId,
    source = "runtime_controller",
    result,
    status,
    code,
    observedAt,
  }: Readonly<{
    runId: string;
    source?: string;
    result: string;
    status?: number;
    code?: string;
  }> &
    OptionalObservedAt,
): Promise<void> {
  await appendRuntimeEvent(db, {
    runId,
    observedAt,
    type: "realtime.close_finished",
    payload: withoutUndefined({
      source,
      result,
      status,
      code,
    }),
  });
}

function toLabRunListItem(row: LabRunRow): LabRunSummary {
  const summary: LabRunSummaryDraft = {
    runId: row.runId,
    startedAt: row.startedAt,
    transcriptTurnCount: row.transcript.turns.length,
  };
  if (row.endedAt !== null) summary.endedAt = row.endedAt;
  if (row.outcome !== null) summary.outcome = row.outcome;
  if (row.endReason !== null) summary.endReason = row.endReason;
  return summary;
}

type MutableLabRun = { -readonly [Key in keyof LabRun]: LabRun[Key] };
type MutableLabResponseUsage = { -readonly [Key in keyof LabResponseUsage]: LabResponseUsage[Key] };

function toLabRunDetail(row: LabRunRow, usageRows: readonly Record<string, unknown>[]): LabRun {
  const usage = usageRows.flatMap((item) => {
    if (
      typeof item.response_id !== "string" ||
      typeof item.output_tokens !== "number" ||
      !Number.isSafeInteger(item.output_tokens) ||
      item.output_tokens < 0
    )
      return [];
    const entry: MutableLabResponseUsage = {
      responseId: item.response_id,
      outputTokens: item.output_tokens,
    };
    if (row.executionModel !== null) entry.model = row.executionModel;
    return [entry];
  });
  const validTranscript = isRuntimeTranscriptPayload(row.transcript, {
    requireTranscriptTurns: true,
  });
  const interviewerTurnIndexes = validTranscript
    ? row.transcript.turns.flatMap((turn, index) =>
        turn.role === "conversationAgent" ? [index] : [],
      )
    : [];
  if (
    usageRows.length === 1 &&
    usage.length === 1 &&
    interviewerTurnIndexes.length === 1 &&
    usageRows[0]?.assistant_message === 1
  ) {
    const onlyUsage = usage[0];
    const onlyIndex = interviewerTurnIndexes[0];
    if (onlyUsage !== undefined && onlyIndex !== undefined)
      onlyUsage.answerTurnNumber = onlyIndex + 1;
  }
  const detail: MutableLabRun = {
    ...toLabRunListItem(row),
    transcript: row.transcript,
    responseUsage: usage,
  };
  if (row.executionModel !== null) detail.executionModel = row.executionModel;
  if (row.maxOutputTokens !== null) detail.maxOutputTokens = row.maxOutputTokens;
  return detail;
}

function toRuntimeRunDiagnostics(
  labRunRow: LabDiagnosticsRow,
  diagnosticsRow: RunDiagnosticSummaryRow | null,
): Readonly<Record<string, unknown>> {
  return withoutUndefined({
    runId: labRunRow.runId,
    startedAt: diagnosticsRow?.started_at ?? labRunRow.startedAt,
    endedAt: diagnosticsRow?.ended_at ?? labRunRow.endedAt ?? undefined,
    surface: diagnosticsRow?.surface,
    environment: diagnosticsRow?.environment,
    appResourceKind: diagnosticsRow?.app_resource_kind,
    appResourceId: diagnosticsRow?.app_resource_id,
    diagnosticSchemaVersion: diagnosticsRow?.diagnostic_schema_version,
    runtimeControllerVersion: diagnosticsRow?.runtime_controller_version ?? undefined,
    expiresAt: diagnosticsRow?.expires_at,
    sessionId: diagnosticsRow?.session_id ?? undefined,
    setupFailure: parseStoredJson(diagnosticsRow?.setup_failure_json) ?? undefined,
    settingsSummary: parseStoredJson(diagnosticsRow?.settings_summary_json) ?? undefined,
    promptProvenance:
      parseStoredJson(diagnosticsRow?.prompt_provenance_json) ??
      labRunRow.promptProvenance ??
      undefined,
    completionStatus: diagnosticsRow?.completion_status ?? undefined,
    completionReviewStatus: diagnosticsRow?.completion_review_status ?? undefined,
    completionDebugText: diagnosticsRow?.completion_debug_text ?? undefined,
  });
}

async function assertLabSnapshotDigest(snapshot: RuntimeTranscriptSnapshot): Promise<void> {
  if (snapshot.turnCount !== snapshot.transcript.turns.length) {
    throw new Error("invalid_runtime_transcript_turn_count");
  }

  const digest = await computeRuntimeTranscriptDigest(snapshot.transcript);

  if (digest !== snapshot.digest) {
    throw new Error("invalid_runtime_transcript_digest");
  }
}

export async function getLabTranscriptSnapshotRow(
  db: D1DatabaseCapability,
  runId: string,
): Promise<LabTranscriptSnapshotRow | null> {
  const row = await db
    .prepare(
      `SELECT
        ended_at,
        outcome,
        end_reason,
        runtime_completion_json,
        transcript_json,
        transcript_revision,
        transcript_digest,
        transcript_turn_count
      FROM lab_runs
      WHERE run_id = ?`,
    )
    .bind(runId)
    .first();

  if (row === null) {
    return null;
  }

  return labTranscriptSnapshotRowBoundary(row);
}

function serializeRuntimeCompletion(completion: RuntimeCompletion): string {
  return JSON.stringify({
    runId: completion.runId,
    outcome: completion.outcome,
    endReason: completion.endReason,
    source: completion.source,
    endingStartedAt: completion.endingStartedAt,
    endedAt: completion.endedAt,
    finalizedAt: completion.finalizedAt,
    transcriptSnapshot: {
      revision: completion.transcriptSnapshot.revision,
      digest: completion.transcriptSnapshot.digest,
      turnCount: completion.transcriptSnapshot.turnCount,
    },
    warnings: completion.warnings,
  });
}

function labSnapshotReceipt(
  status: SnapshotReceipt["status"],
  storedSnapshot: RuntimeTranscriptSnapshotRef | null,
  requestedMatches: boolean,
): SnapshotReceipt {
  return {
    version: 2,
    status,
    storedSnapshot,
    requestedMatches,
  };
}

function labSnapshotReceiptAfterWrite(
  requestedSnapshot: RuntimeTranscriptSnapshotRef,
  storedSnapshot: RuntimeTranscriptSnapshotRef | null,
): SnapshotReceipt {
  const requestedMatches = matchesTranscriptSnapshotIdentity(storedSnapshot, requestedSnapshot);
  return labSnapshotReceipt(
    requestedMatches
      ? "stored"
      : storedSnapshot !== null && storedSnapshot.revision > requestedSnapshot.revision
        ? "stale"
        : "conflict",
    storedSnapshot,
    requestedMatches,
  );
}

function labCompletionReceipt(
  status: CompletionReceipt["status"],
  storedSnapshot: RuntimeTranscriptSnapshotRef | null,
  requestedMatches: boolean,
): CompletionReceipt {
  return {
    version: 2,
    status,
    storedSnapshot,
    requestedMatches,
  };
}

function readStoredTranscriptSnapshot<Revision, Digest, TurnCount>(
  revisionValue: Revision,
  digestValue: Digest,
  turnCountValue: TurnCount,
): RuntimeTranscriptSnapshotRef | null {
  const revision = requireNullableNumber(revisionValue);
  const digest = readNullableString(digestValue);
  const turnCount = requireNullableNumber(turnCountValue);
  const values = [revision, digest, turnCount];

  if (values.every((value) => value === null)) {
    return null;
  }

  if (
    revision === null ||
    digest === null ||
    turnCount === null ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(digest) ||
    !Number.isSafeInteger(turnCount) ||
    turnCount < 0
  ) {
    throw new TypeError("invalid_lab_transcript_identity");
  }

  return { revision, digest, turnCount };
}

async function ensureLabRunDiagnosticSummary(
  db: D1DatabaseCapability,
  runId: string,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT
        run_id,
        started_at,
        ended_at,
        prompt_provenance_json
      FROM lab_runs
      WHERE run_id = ?`,
    )
    .bind(runId)
    .first();

  if (row === null) {
    throw new Error("lab_run_not_found");
  }

  const labRunRow = labDiagnosticsRowBoundary(row);

  const diagnosticSummary: LabDiagnosticSummaryInput = {
    runId,
    surface: "lab",
    environment: readDiagnosticsEnvironment(),
    appResourceKind: "lab_run",
    appResourceId: runId,
    startedAt: labRunRow.startedAt,
  };
  if (labRunRow.endedAt !== null) diagnosticSummary.endedAt = labRunRow.endedAt;
  if (labRunRow.promptProvenance !== null) {
    diagnosticSummary.promptProvenance = labRunRow.promptProvenance;
  }
  await ensureRunDiagnosticSummary(db, diagnosticSummary);
}

function parseTranscript<Value>(json: Value): RuntimeTranscriptPayload {
  const parsed = parseStoredJson(json);
  const transcript = storedTranscriptSchema.safeParse(parsed);

  if (transcript.success) {
    return transcript.data;
  }

  return {
    turns: [],
  };
}

function matchesCanonicalTranscriptJson(stored: string, requested: string): boolean {
  const parsed = parseStoredJson(stored);
  return (
    isRuntimeTranscriptPayload(parsed, { requireTranscriptTurns: true }) &&
    canonicalizeRuntimeTranscript(parsed) === requested
  );
}

function parseStoredJson<Value>(json: Value): StoredJsonValue | null {
  if (typeof json !== "string" || json.length === 0) {
    return null;
  }

  try {
    const parsed = storedJsonValueSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function getChangeCount(result: D1RunResultCapability): number {
  return typeof result?.meta?.changes === "number" ? result.meta.changes : 0;
}

function requireString<Value>(value: Value): string {
  if (typeof value !== "string") {
    throw new TypeError("invalid_lab_run_row");
  }

  return value;
}

function requireNumber<Value>(value: Value): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("invalid_lab_run_row");
  }

  return value;
}

function readNullableString<Value>(value: Value): string | null {
  return value === null || value === undefined ? null : requireString(value);
}

function readMaxOutputTokens(value: string | null | undefined): number | "inf" | null {
  if (value === null || value === undefined) return null;
  if (value === "inf") return "inf";
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 4096)
    throw new TypeError("invalid_lab_run_row");
  return count;
}

function requireNullableNumber<Value>(value: Value): number | null {
  return value === null ? null : requireNumber(value);
}

function requireNullableLabRunOutcome<Value>(value: Value): RuntimeTerminalOutcome | null {
  if (value === null) {
    return null;
  }

  if (!isRuntimeTerminalOutcome(value)) {
    throw new TypeError("invalid_lab_run_row");
  }

  return value;
}

function requireNullableLabRunEndReason<Value>(value: Value): RuntimeEndReason | null {
  if (value === null) {
    return null;
  }

  if (!isRuntimeEndReason(value)) {
    throw new TypeError("invalid_lab_run_row");
  }

  return value;
}
