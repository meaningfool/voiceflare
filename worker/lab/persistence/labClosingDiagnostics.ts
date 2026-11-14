import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import type { D1DatabaseCapability } from "../../shared/persistence/runDiagnosticsD1.ts";
import { decodeRuntimeDiagnosticRecord } from "../../shared/contracts/runtimeDiagnostics.ts";
import { closingAssessmentOf, closingAssessmentType } from "../../conversations/registered.ts";

export const labClosingDiagnosticEventType = closingAssessmentType;
const eventType = labClosingDiagnosticEventType;
const closingWarningSchema = z.enum([
  "closing_response_failed",
  "closing_cutoff_exhausted",
  "closing_recovery_uncertain",
  "closing_interrupted",
]);
export type LabClosingDiagnostic = Readonly<{
  status: "limited" | "checked" | "unknown";
  warnings: readonly z.output<typeof closingWarningSchema>[];
}>;
const savedRun = boundary({
  schema: z.strictObject({
    start_request_json: z.string().nullable(),
    ended_at: z.number().int().safe().nonnegative().nullable(),
    end_reason: z.string().nullable(),
  }),
  convert: (row) => row,
});
const savedSelection = boundary({
  schema: z.object({
    selection: z
      .object({ conversation: z.object({ id: z.string(), version: z.number() }) })
      .optional(),
  }),
  convert: (input) => input.selection?.conversation,
});
async function readClosingRun(db: D1DatabaseCapability, runId: string) {
  const raw = await db
    .prepare("SELECT start_request_json, ended_at, end_reason FROM lab_runs WHERE run_id = ?")
    .bind(runId)
    .first();
  if (raw === null) return null;
  const row = savedRun(raw);
  if (row.start_request_json === null || row.ended_at === null) return null;
  const selection = savedSelection(JSON.parse(row.start_request_json));
  // Only a Conversation whose module declares a closing assessment has a closing review.
  const assessment = selection === undefined ? undefined : closingAssessmentOf(selection);
  return selection === undefined || assessment === undefined
    ? null
    : { ...row, conversation: selection, assessment };
}
const storedAssessment = boundary({
  schema: z.json().pipe(z.strictObject({ runtime_record_json: z.string() })),
  convert: (row) => decodeRuntimeDiagnosticRecord(JSON.parse(row.runtime_record_json)),
});
async function readWarnings(
  db: D1DatabaseCapability,
  runId: string,
  conversation: Readonly<{ id: string; version: number }>,
  assessment: z.ZodType,
) {
  const row = await db
    .prepare(
      "SELECT runtime_record_json FROM runtime_events WHERE run_id = ? AND type = ? AND record_id IS NOT NULL AND expires_at > ? ORDER BY sequence DESC LIMIT 1",
    )
    .bind(runId, eventType, Date.now())
    .first();
  if (row === null) return null;
  const record = storedAssessment(row);
  if (
    record.runId !== runId ||
    record.source !== "conversation" ||
    record.selection?.conversation.id !== conversation.id ||
    record.selection.conversation.version !== conversation.version
  )
    return null;
  const payload = assessment
    .pipe(z.object({ warnings: z.array(closingWarningSchema) }))
    .safeParse(JSON.parse(record.payloadJson));
  return payload.success ? payload.data.warnings : null;
}
export async function getLabClosingDiagnostic(
  db: D1DatabaseCapability,
  runId: string,
): Promise<LabClosingDiagnostic | undefined> {
  let run: Awaited<ReturnType<typeof readClosingRun>>;
  try {
    run = await readClosingRun(db, runId);
    if (run === null) return undefined;
  } catch {
    // The optional selection projection must not make an unrelated run unreadable.
    return undefined;
  }
  try {
    const warnings = await readWarnings(db, runId, run.conversation, run.assessment);
    return warnings === null
      ? { status: "unknown", warnings: [] }
      : { status: warnings.length === 0 ? "checked" : "limited", warnings };
  } catch {
    return { status: "unknown", warnings: [] };
  }
}
