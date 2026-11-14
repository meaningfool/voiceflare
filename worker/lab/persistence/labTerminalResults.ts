import type { D1DatabaseCapability } from "../../shared/persistence/runDiagnosticsD1.ts";
import {
  parseRuntimeTerminalResult,
  type RuntimeTerminalResult,
} from "../../shared/contracts/runtimeTerminalResult.ts";
import { matchesTranscriptSnapshotIdentity } from "../../shared/runtimeTranscriptSnapshot.ts";
import { decideLabStartup } from "./labStartup.ts";
import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

const terminalRowSchema = z.strictObject({
  terminal_result_json: z.string().nullable(),
  transcript_revision: z.number().int().safe().nonnegative().nullable(),
  transcript_digest: z.string().nullable(),
  transcript_turn_count: z.number().int().safe().nonnegative().nullable(),
});
const terminalRow = boundary({
  schema: z
    .unknown()
    .refine(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        terminalRowSchema.keyof().options.every((key) => Object.hasOwn(value, key)),
    )
    .pipe(terminalRowSchema),
  convert: (row) => row,
});
export async function getLabTerminalResult(
  db: D1DatabaseCapability,
  runId: string,
): Promise<RuntimeTerminalResult | null> {
  const raw = await db
    .prepare(
      `SELECT terminal_result_json, transcript_revision, transcript_digest, transcript_turn_count FROM lab_runs WHERE run_id = ?`,
    )
    .bind(runId)
    .first();
  if (raw === null) return null;
  const row = terminalRow(raw);
  if (row.terminal_result_json === null) return null;
  const result = parseRuntimeTerminalResult(JSON.parse(row.terminal_result_json));
  if (result === null || result.runId !== runId) throw new Error("invalid_lab_terminal_result");
  return result;
}
export async function persistLabTerminalResult(
  db: D1DatabaseCapability,
  result: RuntimeTerminalResult,
): Promise<"completed" | "idempotent" | "snapshot_mismatch" | "completion_conflict" | null> {
  // A validated terminal result ends the pending startup opportunity even when its
  // matching Transcript has not arrived. Resolve this before any awaitable receipt
  // work so readiness cannot accept an already-known ending.
  const startup = await decideLabStartup(db, {
    runId: result.runId,
    decision: "failed",
    reason: "terminal_result_received",
    now: Date.now(),
  });
  if (startup === null) return null;
  const json = JSON.stringify(result);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await db
      .prepare(
        `SELECT terminal_result_json, transcript_revision, transcript_digest, transcript_turn_count FROM lab_runs WHERE run_id = ?`,
      )
      .bind(result.runId)
      .first();
    if (raw === null) return null;
    const row = terminalRow(raw);
    if (result.outcome !== "failed_to_start") {
      const snapshot =
        row.transcript_revision !== null &&
        row.transcript_digest !== null &&
        row.transcript_turn_count !== null
          ? {
              revision: row.transcript_revision,
              digest: row.transcript_digest,
              turnCount: row.transcript_turn_count,
            }
          : null;
      if (!matchesTranscriptSnapshotIdentity(snapshot, result.transcriptSnapshot))
        return "snapshot_mismatch";
    }
    if (row.terminal_result_json !== null) {
      const stored = parseRuntimeTerminalResult(JSON.parse(row.terminal_result_json));
      if (stored === null) throw new Error("invalid_lab_terminal_result");
      return JSON.stringify(stored) === json ? "idempotent" : "completion_conflict";
    }
    const ref = result.outcome === "failed_to_start" ? null : result.transcriptSnapshot;
    const write = await db
      .prepare(`UPDATE lab_runs SET terminal_result_json = ?, ended_at = ?, outcome = ?, end_reason = ?
      WHERE run_id = ? AND terminal_result_json IS NULL AND runtime_completion_json IS NULL
      AND (? IS NULL OR (transcript_revision = ? AND transcript_digest = ? AND transcript_turn_count = ?))`)
      .bind(
        json,
        result.endedAt,
        result.outcome === "completed" ? "ended" : "failed",
        result.outcome === "completed" ? result.reason : "runtime_failed",
        result.runId,
        ref?.revision ?? null,
        ref?.revision ?? null,
        ref?.digest ?? null,
        ref?.turnCount ?? null,
      )
      .run();
    if (typeof write.meta?.changes === "number" && write.meta.changes > 0) return "completed";
  }
  const raw = await db
    .prepare(
      `SELECT terminal_result_json, transcript_revision, transcript_digest, transcript_turn_count FROM lab_runs WHERE run_id = ?`,
    )
    .bind(result.runId)
    .first();
  if (raw === null) return null;
  return terminalRow(raw).terminal_result_json === json ? "completed" : "completion_conflict";
}
