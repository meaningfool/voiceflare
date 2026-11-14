import { afterEach, describe, expect, it } from "vitest";
import { createTestLabD1Database, type TestD1DatabaseHandle } from "../../shared/testing/d1.ts";
import { createRuntimeTranscriptSnapshot } from "../../shared/runtimeTranscriptSnapshot.ts";
import { createLabRun, getLabRun, appendLabRuntimeDiagnosticRecords } from "./labD1.ts";
import { persistLabTerminalResult } from "./labTerminalResults.ts";
import { handleLabStorageRoute } from "../routes/labStorage.ts";
import { originalRealtimeSelection } from "../../shared/contracts/conversationSelection.ts";
import type { RuntimeDiagnosticRecord } from "../../shared/contracts/runtimeDiagnostics.ts";

let database: TestD1DatabaseHandle | undefined;
afterEach(() => {
  database?.close();
  database = undefined;
});
async function savedRun() {
  database = createTestLabD1Database();
  const created = await createLabRun(database.d1, {
    now: () => 1000,
    startAttempt: {
      attemptId: "closing-test",
      requestJson: JSON.stringify({
        selection: { conversation: { id: "goodbye-interview", version: 1 } },
      }),
    },
  });
  const snapshot = await createRuntimeTranscriptSnapshot(0, { turns: [] });
  const terminal = {
    runId: created.runId,
    outcome: "completed" as const,
    reason: "timebox_reached" as const,
    liveAt: 1100,
    endedAt: 2000,
    transcriptSnapshot: { revision: 0, digest: snapshot.digest, turnCount: 0 },
    transcriptCompleteness: "complete" as const,
    transcriptIncompleteReasons: [],
    runtimeUsage: { completeness: "complete" as const, observations: [] },
  };
  await persistLabTerminalResult(database.d1, terminal);
  return { db: database.d1, runId: created.runId, terminal };
}
function assessment<Payload>(runId: string, payload: Payload): RuntimeDiagnosticRecord {
  return {
    recordId: `${runId}:1`,
    runId,
    source: "conversation",
    selection: {
      ...originalRealtimeSelection,
      conversation: { id: "goodbye-interview", version: 1 },
    },
    visitId: "visit",
    operationId: "operation",
    sequence: 1,
    observedAt: Date.now(),
    elapsedMs: 1000,
    type: "conversation.closing_assessment",
    payloadJson: JSON.stringify(payload),
  };
}
const read = (runId: string) => new Request(`https://lab.test/_api/runs/${runId}`);

describe("saved Lab closing diagnostics", () => {
  it.each([
    {
      payload: { warnings: [], finalizedAt: 2100, endReason: "timebox_reached" },
      status: "checked",
      warnings: [],
    },
    {
      payload: {
        warnings: ["closing_cutoff_exhausted"],
        finalizedAt: 2100,
        endReason: "timebox_reached",
      },
      status: "limited",
      warnings: ["closing_cutoff_exhausted"],
    },
    {
      payload: { diagnosticOmitted: true, reason: "payload_size" },
      status: "unknown",
      warnings: [],
    },
    {
      payload: { warnings: [42], finalizedAt: 2100, endReason: "timebox_reached" },
      status: "unknown",
      warnings: [],
    },
  ])("projects explicit canonical evidence as $status", async ({ payload, status, warnings }) => {
    const h = await savedRun();
    const record = assessment(h.runId, payload);
    const runtime = {
      fetch: async () =>
        Response.json({ runId: h.runId, records: [record], cursor: 1, hasMore: false }),
    };
    const response = await handleLabStorageRoute(read(h.runId), {
      LAB_DB: h.db,
      RUNTIME_WORKER: runtime,
    });
    expect(await response?.json()).toMatchObject({
      terminalResult: h.terminal,
      closingDiagnostic: { status, warnings },
    });
    const offline = await handleLabStorageRoute(read(h.runId), { LAB_DB: h.db });
    expect(await offline?.json()).toMatchObject({ closingDiagnostic: { status, warnings } });
  });
  it("does not resurrect expired Runtime evidence or turn it into a clean assessment", async () => {
    const h = await savedRun();
    const expired = {
      ...assessment(h.runId, { warnings: [], finalizedAt: 2100, endReason: "timebox_reached" }),
      observedAt: 1,
    };
    const runtime = {
      fetch: async () =>
        Response.json({ runId: h.runId, records: [expired], cursor: 1, hasMore: false }),
    };
    const response = await handleLabStorageRoute(read(h.runId), {
      LAB_DB: h.db,
      RUNTIME_WORKER: runtime,
    });
    expect(await response?.json()).toMatchObject({
      terminalResult: h.terminal,
      closingDiagnostic: { status: "unknown", warnings: [] },
    });
    expect(
      (await h.db.prepare("SELECT COUNT(*) AS count FROM runtime_events").first())?.count,
    ).toBe(0);
  });
  it("keeps absent evidence unavailable and canonical results readable after diagnostic-only table failure", async () => {
    const h = await savedRun();
    expect(await getLabRun(h.db, h.runId)).toMatchObject({
      terminalResult: h.terminal,
      closingDiagnostic: { status: "unknown" },
    });
    await h.db.prepare("DROP TABLE lab_response_usage").run();
    await h.db.prepare("DROP TABLE runtime_events").run();
    const response = await handleLabStorageRoute(read(h.runId), { LAB_DB: h.db });
    expect(await response?.json()).toMatchObject({
      terminalResult: h.terminal,
      closingDiagnostic: { status: "unknown" },
    });
  });
  it("keeps a corrupt recovery position and malformed stored assessment from blocking the saved result", async () => {
    const h = await savedRun();
    await h.db
      .prepare("INSERT INTO runtime_diagnostic_recovery(run_id, cursor) VALUES (?, ?)")
      .bind(h.runId, "invalid")
      .run();
    const record = assessment(h.runId, {
      warnings: [],
      finalizedAt: 2100,
      endReason: "timebox_reached",
    });
    const runtime = {
      fetch: async () =>
        Response.json({ runId: h.runId, records: [record], cursor: 1, hasMore: false }),
    };
    const response = await handleLabStorageRoute(read(h.runId), {
      LAB_DB: h.db,
      RUNTIME_WORKER: runtime,
    });
    expect(await response?.json()).toMatchObject({
      terminalResult: h.terminal,
      closingDiagnostic: { status: "unknown" },
    });
    await h.db
      .prepare("UPDATE runtime_diagnostic_recovery SET cursor = 0 WHERE run_id = ?")
      .bind(h.runId)
      .run();
    await handleLabStorageRoute(read(h.runId), { LAB_DB: h.db, RUNTIME_WORKER: runtime });
    expect(await getLabRun(h.db, h.runId)).toMatchObject({
      closingDiagnostic: { status: "checked" },
    });
    await h.db
      .prepare("UPDATE runtime_events SET runtime_record_json = ? WHERE run_id = ?")
      .bind('{"runId":42}', h.runId)
      .run();
    expect(await getLabRun(h.db, h.runId)).toMatchObject({
      terminalResult: h.terminal,
      closingDiagnostic: { status: "unknown" },
    });
  });

  it("persists one trusted record under overlapping recovery and retries a failed page", async () => {
    const h = await savedRun();
    const record = assessment(h.runId, {
      warnings: [],
      finalizedAt: 2100,
      endReason: "timebox_reached",
    });
    await Promise.all([
      appendLabRuntimeDiagnosticRecords(h.db, h.runId, [record]),
      appendLabRuntimeDiagnosticRecords(h.db, h.runId, [record]),
    ]);
    const rows = await h.db
      .prepare("SELECT record_id FROM runtime_events WHERE run_id = ?")
      .bind(h.runId)
      .all();
    expect(rows.results).toEqual([{ record_id: record.recordId }]);
  });
  it("accepts browser diagnostics without granting authoritative attribution", async () => {
    const h = await savedRun();
    const response = await handleLabStorageRoute(
      new Request(`https://lab.test/_api/runs/${h.runId}/runtime-events`, {
        method: "POST",
        body: JSON.stringify({
          records: [
            {
              type: "browser.live_degraded",
              payload: { source: "browser", degradationKind: "browser_runtime_event_stream" },
            },
          ],
        }),
      }),
      { LAB_DB: h.db },
    );
    expect(response?.status).toBe(201);
    const events = await h.db
      .prepare("SELECT type, record_id, runtime_record_json FROM runtime_events")
      .all();
    expect(events.results).toEqual([
      { type: "browser.live_degraded", record_id: null, runtime_record_json: null },
    ]);
  });
  it.each([
    "realtime.provider_event_observed",
    "conversation.closing_assessment",
    "execution.observation",
    "lab.closing_review",
  ])("rejects browser impersonation of %s", async (type) => {
    const h = await savedRun();
    const response = await handleLabStorageRoute(
      new Request(`https://lab.test/_api/runs/${h.runId}/runtime-events`, {
        method: "POST",
        body: JSON.stringify({ records: [{ type, payload: { warnings: [] } }] }),
      }),
      { LAB_DB: h.db },
    );
    expect(response?.status).toBe(400);
    expect(
      (await h.db.prepare("SELECT COUNT(*) AS count FROM runtime_events").first())?.count,
    ).toBe(0);
  });
});
