import { sanitizeDiagnosticPayload } from "../diagnosticPayload.ts";
import {
  decodeRuntimeDiagnosticRecord,
  diagnosticPayloadJsonSchema,
  runtimeDiagnosticRetentionMs,
  type RuntimeDiagnosticRecord,
} from "../contracts/runtimeDiagnostics.ts";
import { z } from "zod";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { redactSecrets, type RedactableData } from "../http.ts";

export type D1RunResultCapability = Readonly<{
  success?: boolean;
  meta?: Readonly<Record<string, unknown>>;
}>;

export type D1RowsResultCapability = Readonly<{
  results: readonly Readonly<Record<string, unknown>>[];
  success?: boolean;
  meta?: Readonly<Record<string, unknown>>;
}>;

export interface D1PreparedStatementCapability {
  bind(...values: unknown[]): D1PreparedStatementCapability;
  run(): Promise<D1RunResultCapability>;
  all(): Promise<D1RowsResultCapability>;
  first(): Promise<Readonly<Record<string, unknown>> | null>;
}

export interface D1DatabaseCapability {
  prepare(query: string): D1PreparedStatementCapability;
}

export type RunDiagnosticSummaryRow = Readonly<{
  run_id: string;
  surface: string;
  environment: string;
  app_resource_kind: string;
  app_resource_id: string;
  diagnostic_schema_version: number;
  runtime_controller_version: string | null;
  started_at: number;
  ended_at: number | null;
  expires_at: number;
  session_id: string | null;
  setup_failure_json: string | null;
  startup_json: string | null;
  settings_summary_json: string | null;
  prompt_provenance_json: string | null;
  completion_status: string | null;
  completion_review_status: string | null;
  completion_debug_text: string | null;
}>;

export type RunDiagnosticEvent = Readonly<{
  runId: string;
  observedAt: number;
  sequence: number;
  elapsedMs: number;
  type: string;
  payloadJson: string;
  runtimeRecord?: RuntimeDiagnosticRecord;
}>;

type EnsureRunDiagnosticSummaryInput = Readonly<{
  runId: string;
  surface: string;
  environment?: string;
  appResourceKind: string;
  appResourceId: string;
  startedAt: number;
  endedAt?: number;
  promptProvenance?: unknown;
  runtimeControllerVersion?: string;
  expiresAt?: number;
}>;

type UpdateRunDiagnosticSummaryInput = Readonly<{
  runId: string;
  endedAt?: number;
  sessionId?: string;
  setupFailure?: unknown;
  settingsSummary?: unknown;
  completionStatus?: string;
  completionReviewStatus?: string | null;
  completionDebugText?: string;
}>;

type RunDiagnosticEventInput = Readonly<{
  observedAt?: unknown;
  sequence?: unknown;
  elapsedMs?: unknown;
  type: string;
  payloadJson?: unknown;
  payload?: unknown;
  expiresAt?: unknown;
}>;

export const runDiagnosticSchemaVersion = 1;
export const runDiagnosticEventRetentionMs = runtimeDiagnosticRetentionMs;
export const runDiagnosticSummaryRetentionMs = 180 * 24 * 60 * 60 * 1000;
export const maxRunDiagnosticEventListLimit = 2_000;

const defaultEnvironment = "local";
const maxPayloadJsonLength = 4_000;
const maxDiagnosticStringLength = 500;

const runDiagnosticSummaryRowSchema = z.object({
  run_id: z.string(),
  surface: z.string(),
  environment: z.string(),
  app_resource_kind: z.string(),
  app_resource_id: z.string(),
  diagnostic_schema_version: z.number().finite(),
  runtime_controller_version: z.string().nullable(),
  started_at: z.number().finite(),
  ended_at: z.number().finite().nullable(),
  expires_at: z.number().finite(),
  session_id: z.string().nullable(),
  setup_failure_json: z.string().nullable(),
  startup_json: z.string().nullable(),
  settings_summary_json: z.string().nullable(),
  prompt_provenance_json: z.string().nullable(),
  completion_status: z.string().nullable(),
  completion_review_status: z.string().nullable(),
  completion_debug_text: z.string().nullable(),
});

const runDiagnosticEventRowSchema = z.object({
  run_id: z.string(),
  observed_at: z.number().finite(),
  sequence: z.number().finite(),
  elapsed_ms: z.number().finite(),
  type: z.string(),
  payload_json: diagnosticPayloadJsonSchema,
  runtime_record_json: z.string().nullable().optional(),
});

const decodeRunDiagnosticSummaryRow = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    runDiagnosticSummaryRowSchema,
  ),
  convert: (row): RunDiagnosticSummaryRow => row,
});

const decodeRunDiagnosticEvent = boundary({
  schema: z.preprocess(
    (value) => (value === undefined ? value : z.json().parse(value)),
    runDiagnosticEventRowSchema,
  ),
  convert: (row): RunDiagnosticEvent => {
    const event = {
      runId: row.run_id,
      observedAt: row.observed_at,
      sequence: row.sequence,
      elapsedMs: row.elapsed_ms,
      type: row.type,
      payloadJson: row.payload_json,
    };
    if (row.runtime_record_json == null) return event;
    return {
      ...event,
      runtimeRecord: decodeRuntimeDiagnosticRecord(JSON.parse(row.runtime_record_json)),
    };
  },
});

const readNextRunDiagnosticEventSequence = boundary({
  schema: z
    .object({ next_sequence: z.custom<number>((value) => typeof value === "number") })
    .nullable()
    .catch(null),
  convert: (row): number => row?.next_sequence ?? 1,
});

const diagnosticJsonBoundary = boundary({
  schema: z.unknown().transform((value) => ({ value: sanitizeDiagnosticPayload(value) })),
  convert: ({ value }): string => boundedJsonStringify(value),
});

export async function ensureRunDiagnosticSummary(
  db: D1DatabaseCapability,
  {
    runId,
    surface,
    environment = defaultEnvironment,
    appResourceKind,
    appResourceId,
    startedAt,
    endedAt,
    promptProvenance,
    runtimeControllerVersion,
    expiresAt = startedAt + runDiagnosticSummaryRetentionMs,
  }: EnsureRunDiagnosticSummaryInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO run_diagnostic_summaries (
        run_id,
        surface,
        environment,
        app_resource_kind,
        app_resource_id,
        diagnostic_schema_version,
        runtime_controller_version,
        started_at,
        ended_at,
        expires_at,
        prompt_provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      runId,
      surface,
      normalizeDiagnosticString(environment, defaultEnvironment),
      appResourceKind,
      appResourceId,
      runDiagnosticSchemaVersion,
      runtimeControllerVersion ?? null,
      startedAt,
      endedAt ?? null,
      expiresAt,
      promptProvenance === undefined ? null : diagnosticJsonStringify(promptProvenance),
    )
    .run();
}

export async function updateRunDiagnosticSummary(
  db: D1DatabaseCapability,
  {
    runId,
    endedAt,
    sessionId,
    setupFailure,
    settingsSummary,
    completionStatus,
    completionReviewStatus,
    completionDebugText,
  }: UpdateRunDiagnosticSummaryInput,
): Promise<void> {
  const assignments: string[] = [];
  const params: unknown[] = [];

  if (endedAt !== undefined) {
    assignments.push("ended_at = ?");
    params.push(endedAt);
  }

  if (sessionId !== undefined) {
    assignments.push("session_id = ?");
    params.push(normalizeDiagnosticString(sessionId));
  }

  if (setupFailure !== undefined) {
    assignments.push("setup_failure_json = ?");
    params.push(diagnosticJsonStringify(setupFailure));
  }

  if (settingsSummary !== undefined) {
    assignments.push("settings_summary_json = ?");
    params.push(diagnosticJsonStringify(settingsSummary));
  }

  if (completionStatus !== undefined) {
    assignments.push("completion_status = ?");
    params.push(normalizeDiagnosticString(completionStatus));
  }

  if (completionReviewStatus !== undefined) {
    assignments.push("completion_review_status = ?");
    params.push(
      completionReviewStatus === null ? null : normalizeDiagnosticString(completionReviewStatus),
    );
  }

  if (completionDebugText !== undefined) {
    assignments.push("completion_debug_text = ?");
    params.push(normalizeDiagnosticString(completionDebugText));
  }

  if (assignments.length === 0) {
    return;
  }

  await db
    .prepare(
      `UPDATE run_diagnostic_summaries
      SET ${assignments.join(", ")}
      WHERE run_id = ?`,
    )
    .bind(...params, runId)
    .run();
}

export async function getRunDiagnosticSummary(
  db: D1DatabaseCapability,
  runId: string,
): Promise<RunDiagnosticSummaryRow | null> {
  const row = await db
    .prepare(
      `SELECT
        run_id,
        surface,
        environment,
        app_resource_kind,
        app_resource_id,
        diagnostic_schema_version,
        runtime_controller_version,
        started_at,
        ended_at,
        expires_at,
        session_id,
        setup_failure_json,
        startup_json,
        settings_summary_json,
        prompt_provenance_json,
        completion_status,
        completion_review_status,
        completion_debug_text
      FROM run_diagnostic_summaries
      WHERE run_id = ?`,
    )
    .bind(runId)
    .first();

  return row === null ? null : readRunDiagnosticSummaryRow(row);
}

export async function appendRunDiagnosticEvents(
  db: D1DatabaseCapability,
  { runId, records }: Readonly<{ runId: string; records: readonly RunDiagnosticEventInput[] }>,
): Promise<void> {
  const statement = db.prepare(
    `INSERT INTO runtime_events (
      run_id,
      observed_at,
      sequence,
      elapsed_ms,
      type,
      payload_json,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let nextSequence = await getNextRunDiagnosticEventSequence(db, runId);

  for (const record of records) {
    const observedAt = readFiniteNumber(record.observedAt, Date.now());
    const sequence = readFiniteNumber(record.sequence, nextSequence);
    const elapsedMs = readFiniteNumber(record.elapsedMs, 0);
    const payloadJson = readDiagnosticPayloadJson(record);
    const expiresAt = readFiniteNumber(
      record.expiresAt,
      observedAt + runDiagnosticEventRetentionMs,
    );

    await statement
      .bind(runId, observedAt, sequence, elapsedMs, record.type, payloadJson, expiresAt)
      .run();
    nextSequence = sequence + 1;
  }
}

/** Trusted Runtime ingress only. Browser/app submissions use appendRunDiagnosticEvents. */
export async function appendRuntimeDiagnosticRecords(
  db: D1DatabaseCapability,
  runId: string,
  records: readonly RuntimeDiagnosticRecord[],
): Promise<void> {
  for (const record of records) {
    if (record.runId !== runId) throw new Error("runtime_diagnostic_run_mismatch");
    const result = await db
      .prepare(`INSERT INTO runtime_events
      (run_id, observed_at, sequence, elapsed_ms, type, payload_json, expires_at, record_id, runtime_record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_id) WHERE record_id IS NOT NULL DO NOTHING`)
      .bind(
        runId,
        record.observedAt,
        record.sequence,
        record.elapsedMs,
        record.type,
        record.payloadJson,
        record.observedAt + runDiagnosticEventRetentionMs,
        record.recordId,
        JSON.stringify(record),
      )
      .run();
    if (result.success === false) throw new Error("runtime_diagnostic_write_failed");
  }
}

export async function getRuntimeDiagnosticRecoveryCursor(
  db: D1DatabaseCapability,
  runId: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT cursor FROM runtime_diagnostic_recovery WHERE run_id = ?")
    .bind(runId)
    .first();
  return row === null ? 0 : decodeRecoveryCursor(row);
}
const decodeRecoveryCursor = boundary({
  schema: z.json().pipe(z.strictObject({ cursor: z.number().int().safe().nonnegative() })),
  convert: (row) => row.cursor,
});
export async function advanceRuntimeDiagnosticRecoveryCursor(
  db: D1DatabaseCapability,
  runId: string,
  cursor: number,
): Promise<void> {
  const result = await db
    .prepare(`INSERT INTO runtime_diagnostic_recovery(run_id, cursor) VALUES (?, ?)
    ON CONFLICT(run_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)`)
    .bind(runId, cursor)
    .run();
  if (result.success === false) throw new Error("runtime_diagnostic_cursor_write_failed");
}

export async function listRunDiagnosticEvents<Limit>(
  db: D1DatabaseCapability,
  runId: string,
  limit?: Limit,
): Promise<RunDiagnosticEvent[]> {
  const boundedLimit = Math.min(
    Math.max(Math.trunc(readFiniteNumber(limit, maxRunDiagnosticEventListLimit)), 0),
    maxRunDiagnosticEventListLimit,
  );
  const result = await db
    .prepare(
      `SELECT
        run_id,
        observed_at,
        sequence,
        elapsed_ms,
        type,
        payload_json,
        runtime_record_json
      FROM runtime_events
      WHERE run_id = ? AND (record_id IS NULL OR expires_at > ?)
      ORDER BY observed_at ASC, sequence ASC
      LIMIT ?`,
    )
    .bind(runId, Date.now(), boundedLimit)
    .all();

  return result.results.map(readRunDiagnosticEvent);
}

export async function purgeExpiredRunDiagnosticEvents(
  db: D1DatabaseCapability,
  { now = Date.now() }: Readonly<{ now?: unknown }> = {},
): Promise<Readonly<{ deletedCount: number; purgeBeforeOrAt: number }>> {
  const purgeBeforeOrAt = readFiniteNumber(now, Date.now());
  const result = await db
    .prepare("DELETE FROM runtime_events WHERE expires_at <= ?")
    .bind(purgeBeforeOrAt)
    .run();

  return {
    deletedCount: getChangeCount(result),
    purgeBeforeOrAt,
  };
}

export function readDiagnosticsEnvironment<Environment extends object = object>(
  env?: Environment,
): string {
  const environment = env !== undefined && "ENVIRONMENT" in env ? env.ENVIRONMENT : undefined;

  return normalizeDiagnosticString(environment, defaultEnvironment);
}

export function diagnosticJsonStringify<Value>(value: Value): string {
  return diagnosticJsonBoundary(value);
}

function readDiagnosticPayloadJson(record: RunDiagnosticEventInput): string {
  if (typeof record.payloadJson === "string") {
    return diagnosticJsonStringify(
      parseJson(record.payloadJson) ?? { message: record.payloadJson },
    );
  }

  return diagnosticJsonStringify(record.payload ?? {});
}

function boundedJsonStringify(value: RedactableData): string {
  const json = JSON.stringify(value);

  if (json === undefined) {
    throw new TypeError("invalid_diagnostic_json");
  }

  if (json.length <= maxPayloadJsonLength) {
    return json;
  }

  return JSON.stringify({ diagnosticOmitted: true, reason: "payload_size" });
}

function normalizeDiagnosticString<Value>(value: Value, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = redactSecrets(value).trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
    return fallback;
  }

  return normalized.length > maxDiagnosticStringLength
    ? `${normalized.slice(0, maxDiagnosticStringLength - 3)}...`
    : normalized;
}

async function getNextRunDiagnosticEventSequence(
  db: D1DatabaseCapability,
  runId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM runtime_events WHERE run_id = ?",
    )
    .bind(runId)
    .first();

  return readNextRunDiagnosticEventSequence(row);
}

function readFiniteNumber<Value>(value: Value, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getChangeCount(result: D1RunResultCapability): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

function readRunDiagnosticSummaryRow<Value>(row: Value): RunDiagnosticSummaryRow {
  try {
    return decodeRunDiagnosticSummaryRow(row);
  } catch {
    throw new TypeError("invalid_run_diagnostic_row");
  }
}

function readRunDiagnosticEvent<Value>(row: Value): RunDiagnosticEvent {
  try {
    return decodeRunDiagnosticEvent(row);
  } catch {
    throw new TypeError("invalid_run_diagnostic_row");
  }
}

function parseJson(json: string) {
  try {
    return redactSecrets(JSON.parse(json));
  } catch {
    return null;
  }
}
