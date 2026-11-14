import {
  decodeStartupObservation,
  decodeStoredStartup,
  summarizeStartup,
  type StartupObservation,
} from "../contracts/startupDiagnostics.ts";
import {
  appendRunDiagnosticEvents,
  runDiagnosticEventRetentionMs,
  type D1DatabaseCapability,
} from "./runDiagnosticsD1.ts";

export async function recordStartupObservation(
  db: D1DatabaseCapability,
  runId: string,
  observation: StartupObservation,
): Promise<void> {
  await projectStartupObservation(db, runId, observation);
  await appendRunDiagnosticEvents(db, {
    runId,
    records: [
      {
        type: "startup.observed",
        observedAt: observation.at,
        payload: observation,
        // Browser clock skew must not extend event retention.
        expiresAt: Date.now() + runDiagnosticEventRetentionMs,
      },
    ],
  });
}

async function projectStartupObservation(
  db: D1DatabaseCapability,
  runId: string,
  observation: StartupObservation,
): Promise<void> {
  // First observation wins, independently of callback/SSE arrival order.
  const path = observation.failure
    ? `$.failures.${observation.stage}`
    : `$.stages.${observation.stage}`;
  const value = observation.failure ? JSON.stringify(observation) : JSON.stringify(observation.at);
  await db
    .prepare(`UPDATE run_diagnostic_summaries
    SET startup_json = json_insert(COALESCE(startup_json, '{"stages":{},"failures":{}}'), ?, json(?))
    WHERE run_id = ?`)
    .bind(path, value, runId)
    .run();
}

export function readStartupSummary(json: string | null) {
  if (json === null) return undefined;
  return summarizeStartup(decodeStoredStartup(JSON.parse(json)));
}

export async function recordStartupDiagnosticPayload(
  db: D1DatabaseCapability,
  runId: string,
  payloadJson: string,
): Promise<void> {
  await projectStartupObservation(db, runId, decodeStartupObservation(JSON.parse(payloadJson)));
}
