import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import type { D1DatabaseCapability } from "../../shared/persistence/runDiagnosticsD1.ts";

const timestamp = z.number().int().safe().nonnegative();
const startupSchema = z.strictObject({
  run_id: z.string().min(1),
  started_at: timestamp,
  startup_expires_at: timestamp,
  startup_status: z.enum(["pending", "succeeded", "failed"]),
  startup_decided_at: timestamp.nullable(),
  startup_reason: z.string().nullable(),
  runtime_dispatch_intent_at: timestamp.nullable(),
  startup_stop_required: z.union([z.literal(0), z.literal(1)]),
  startup_stop_acknowledged_at: timestamp.nullable(),
  startup_stop_retry_at: timestamp.nullable(),
  startup_stop_attempt_count: timestamp,
});
const readStartup = boundary({
  schema: z
    .unknown()
    .refine(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        startupSchema.keyof().options.every((key) => Object.hasOwn(value, key)),
    )
    .pipe(startupSchema),
  convert: (row) => ({
    runId: row.run_id,
    receivedAt: row.started_at,
    expiresAt: row.startup_expires_at,
    status: row.startup_status,
    decidedAt: row.startup_decided_at,
    reason: row.startup_reason,
    dispatchIntentAt: row.runtime_dispatch_intent_at,
    stopRequired: row.startup_stop_required === 1,
    stopAcknowledgedAt: row.startup_stop_acknowledged_at,
    stopRetryAt: row.startup_stop_retry_at,
    stopAttemptCount: row.startup_stop_attempt_count,
  }),
});
export type LabStartupState = ReturnType<typeof readStartup>;
export async function getLabStartupState(
  db: D1DatabaseCapability,
  runId: string,
): Promise<LabStartupState | null> {
  const row = await db
    .prepare(`SELECT run_id, started_at, startup_expires_at, startup_status,
    startup_decided_at, startup_reason, runtime_dispatch_intent_at, startup_stop_required,
    startup_stop_acknowledged_at, startup_stop_retry_at, startup_stop_attempt_count
    FROM lab_runs WHERE run_id = ?`)
    .bind(runId)
    .first();
  return row === null ? null : readStartup(row);
}
export async function resolveOverdueLabStartup(
  db: D1DatabaseCapability,
  runId: string,
  now: number,
): Promise<LabStartupState | null> {
  await db
    .prepare(`UPDATE lab_runs SET startup_status = 'failed', startup_decided_at = ?,
    startup_reason = 'deadline_expired', startup_stop_required = CASE WHEN runtime_dispatch_intent_at IS NULL THEN 0 ELSE 1 END
    WHERE run_id = ? AND startup_status = 'pending' AND ? >= startup_expires_at`)
    .bind(now, runId, now)
    .run();
  return getLabStartupState(db, runId);
}
export async function decideLabStartup(
  db: D1DatabaseCapability,
  input: Readonly<{ runId: string; decision: "succeeded" | "failed"; reason: string; now: number }>,
): Promise<LabStartupState | null> {
  if (input.decision === "succeeded") {
    await db
      .prepare(`UPDATE lab_runs SET startup_status = 'succeeded', startup_decided_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), startup_reason = ?
      WHERE run_id = ? AND startup_status = 'pending' AND CAST(unixepoch('subsec') * 1000 AS INTEGER) < startup_expires_at`)
      .bind(input.reason, input.runId)
      .run();
    const state = await getLabStartupState(db, input.runId);
    return state?.status === "pending"
      ? resolveOverdueLabStartup(db, input.runId, Math.max(Date.now(), state.expiresAt))
      : state;
  }
  await db
    .prepare(`UPDATE lab_runs SET startup_status = 'failed', startup_decided_at = ?, startup_reason = ?,
    startup_stop_required = CASE WHEN runtime_dispatch_intent_at IS NULL THEN 0 ELSE 1 END
    WHERE run_id = ? AND startup_status = 'pending'`)
    .bind(input.now, input.reason, input.runId)
    .run();
  return getLabStartupState(db, input.runId);
}
export async function recordLabRuntimeDispatchIntent(
  db: D1DatabaseCapability,
  runId: string,
  now: number,
): Promise<LabStartupState | null> {
  await db
    .prepare(`UPDATE lab_runs SET runtime_dispatch_intent_at = COALESCE(runtime_dispatch_intent_at, ?)
    WHERE run_id = ? AND startup_status = 'pending' AND ? < startup_expires_at`)
    .bind(now, runId, now)
    .run();
  return resolveOverdueLabStartup(db, runId, now);
}
export async function recordLabStopAttempt(
  db: D1DatabaseCapability,
  input: Readonly<{ runId: string; retryAt: number; attemptCount: number }>,
): Promise<void> {
  await db
    .prepare(`UPDATE lab_runs SET startup_stop_retry_at = ?, startup_stop_attempt_count = ?
    WHERE run_id = ? AND startup_status = 'failed' AND startup_stop_required = 1 AND startup_stop_acknowledged_at IS NULL`)
    .bind(input.retryAt, input.attemptCount, input.runId)
    .run();
}
export async function acknowledgeLabRequiredStop(
  db: D1DatabaseCapability,
  runId: string,
  at: number,
): Promise<void> {
  await db
    .prepare(`UPDATE lab_runs SET startup_stop_acknowledged_at = COALESCE(startup_stop_acknowledged_at, ?), startup_stop_retry_at = NULL
    WHERE run_id = ? AND startup_status = 'failed' AND startup_stop_required = 1`)
    .bind(at, runId)
    .run();
}
export function toLabStartupDisposition(state: LabStartupState) {
  return {
    runId: state.runId,
    disposition: state.status,
    decidedAt: state.decidedAt,
    reason: state.reason,
    stopRequired: state.stopRequired,
  };
}
