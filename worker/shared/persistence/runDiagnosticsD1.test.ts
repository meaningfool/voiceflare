import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendRunDiagnosticEvents,
  diagnosticJsonStringify,
  ensureRunDiagnosticSummary,
  getRunDiagnosticSummary,
  listRunDiagnosticEvents,
  purgeExpiredRunDiagnosticEvents,
  runDiagnosticEventRetentionMs,
  runDiagnosticSummaryRetentionMs,
  type D1DatabaseCapability,
  type D1PreparedStatementCapability,
} from "./runDiagnosticsD1.ts";
import { createTestLabD1Database, type TestD1DatabaseHandle } from "../testing/d1.ts";

let database: TestD1DatabaseHandle | null = null;

beforeEach(() => {
  database = createTestLabD1Database();
});

afterEach(() => {
  database?.close();
  database = null;
});

function getDatabase(): TestD1DatabaseHandle {
  if (database === null) {
    throw new Error("test_database_not_initialized");
  }

  return database;
}

describe("Shared run diagnostics retention", () => {
  it("stores event expiry, purges expired Run Events, and retains Run Summaries", async () => {
    const database = getDatabase();
    const now = 1_700_000_000_000;
    const expiredObservedAt = now - runDiagnosticEventRetentionMs - 1;
    const recentObservedAt = now - runDiagnosticEventRetentionMs + 1;

    await ensureRunDiagnosticSummary(database.d1, {
      runId: "lab_expired_events",
      surface: "lab",
      appResourceKind: "lab_run",
      appResourceId: "lab_expired_events",
      startedAt: expiredObservedAt,
    });
    await ensureRunDiagnosticSummary(database.d1, {
      runId: "product_recent_events",
      surface: "product",
      appResourceKind: "interview_response",
      appResourceId: "product_recent_events",
      startedAt: recentObservedAt,
    });
    await appendRunDiagnosticEvents(database.d1, {
      runId: "lab_expired_events",
      records: [
        {
          observedAt: expiredObservedAt,
          sequence: 1,
          elapsedMs: 10,
          type: "runtime.old_fact",
          payload: {
            source: "runtime_controller",
          },
        },
      ],
    });
    await appendRunDiagnosticEvents(database.d1, {
      runId: "product_recent_events",
      records: [
        {
          observedAt: recentObservedAt,
          sequence: 1,
          elapsedMs: 10,
          type: "runtime.recent_fact",
          payload: {
            source: "runtime_controller",
          },
        },
      ],
    });

    await expect(
      database.d1
        .prepare("SELECT run_id, expires_at FROM runtime_events ORDER BY run_id ASC")
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          run_id: "lab_expired_events",
          expires_at: expiredObservedAt + runDiagnosticEventRetentionMs,
        },
        {
          run_id: "product_recent_events",
          expires_at: recentObservedAt + runDiagnosticEventRetentionMs,
        },
      ],
    });

    await expect(purgeExpiredRunDiagnosticEvents(database.d1, { now })).resolves.toEqual({
      deletedCount: 1,
      purgeBeforeOrAt: now,
    });
    await expect(listRunDiagnosticEvents(database.d1, "lab_expired_events")).resolves.toEqual([]);
    expect(
      (await listRunDiagnosticEvents(database.d1, "product_recent_events")).map(
        (event) => event.type,
      ),
    ).toEqual(["runtime.recent_fact"]);
    await expect(getRunDiagnosticSummary(database.d1, "lab_expired_events")).resolves.toMatchObject(
      {
        run_id: "lab_expired_events",
        surface: "lab",
        expires_at: expiredObservedAt + runDiagnosticSummaryRetentionMs,
      },
    );
  });

  it("keeps retained diagnostic payloads compact and redacted", async () => {
    const database = getDatabase();
    await ensureRunDiagnosticSummary(database.d1, {
      runId: "run_payload_retention",
      surface: "product",
      appResourceKind: "interview_response",
      appResourceId: "run_payload_retention",
      startedAt: 1_700_000_000_000,
    });
    await appendRunDiagnosticEvents(database.d1, {
      runId: "run_payload_retention",
      records: [
        {
          observedAt: 1_700_000_000_100,
          sequence: 1,
          elapsedMs: 100,
          type: "realtime.provider_event_observed",
          payload: {
            source: "provider",
            providerEventType: "response.done",
            rawProviderPayload: {
              text: "Raw provider payload must not be diagnostics.",
            },
            providerPayload: {
              stack: "stack trace must not be diagnostics.",
            },
            headers: {
              Authorization: "Bearer sk-test-secret",
            },
            publicLinkToken: "public-link-token",
            prompt: "Prompt text must not be diagnostics.",
            sdp: "v=0",
            transcript: {
              turns: [
                {
                  role: "participant",
                  text: "Transcript text must not be diagnostics.",
                },
              ],
            },
          },
        },
      ],
    });

    const events = await listRunDiagnosticEvents(database.d1, "run_payload_retention");
    const event = events[0];

    if (event === undefined) {
      throw new Error("expected_run_diagnostic_event");
    }

    const payloadJson = event.payloadJson;

    expect(JSON.parse(payloadJson)).toEqual({
      source: "provider",
      providerEventType: "response.done",
    });
    expect(
      JSON.parse(
        diagnosticJsonStringify({ values: Array.from({ length: 8 }, () => "x".repeat(500)) }),
      ),
    ).toEqual({ diagnosticOmitted: true, reason: "payload_size" });
  });

  it("fails explicitly when diagnostic JSON or persisted rows are invalid", async () => {
    expect(() => diagnosticJsonStringify(undefined)).toThrowError("invalid_diagnostic_json");

    const invalidRows = createInvalidRowDatabase();

    await expect(getRunDiagnosticSummary(invalidRows, "invalid_summary")).rejects.toThrowError(
      "invalid_run_diagnostic_row",
    );
    await expect(listRunDiagnosticEvents(invalidRows, "invalid_events")).rejects.toThrowError(
      "invalid_run_diagnostic_row",
    );
  });

  it.each(["wrong_startup_type", "inherited_required"] as const)(
    "rejects invalid persisted summary consumer fields: %s",
    async (variant) => {
      await expect(
        getRunDiagnosticSummary(createRowsWithUnownedFieldsDatabase(variant), "owned_summary"),
      ).rejects.toThrow("invalid_run_diagnostic_row");
    },
  );

  it.each(["inherited_event_required", "invalid_payload", "invalid_runtime_record"] as const)(
    "rejects malformed persisted diagnostic events: %s",
    async (variant) => {
      await expect(
        listRunDiagnosticEvents(createRowsWithUnownedFieldsDatabase(variant), "owned_events"),
      ).rejects.toThrow("invalid_run_diagnostic_row");
    },
  );

  it("returns only owned fields from persisted diagnostic rows", async () => {
    const rows = createRowsWithUnownedFieldsDatabase();

    const summary = await getRunDiagnosticSummary(rows, "owned_summary");
    const [event] = await listRunDiagnosticEvents(rows, "owned_events");

    expect(summary).not.toHaveProperty("unowned_summary_field");
    expect(summary).not.toHaveProperty("inherited_summary_field");
    expect(event).not.toHaveProperty("unowned_event_field");
    expect(event).not.toHaveProperty("inherited_event_field");
  });
});

function createInvalidRowDatabase(): D1DatabaseCapability {
  const statement: D1PreparedStatementCapability = {
    bind: () => statement,
    run: async () => ({ success: true }),
    all: async () => ({ results: [{}], success: true }),
    first: async () => ({}),
  };

  return {
    prepare: () => statement,
  };
}

function createRowsWithUnownedFieldsDatabase(
  variant:
    | "valid"
    | "wrong_startup_type"
    | "inherited_required"
    | "inherited_event_required"
    | "invalid_payload"
    | "invalid_runtime_record" = "valid",
): D1DatabaseCapability {
  const eventRow = {
    run_id: "owned_events",
    observed_at: 1_700_000_000_100,
    sequence: 1,
    elapsed_ms: 100,
    type: "runtime.owned_fact",
    payload_json: "{}",
    unowned_event_field: "must_not_escape",
  };
  Object.setPrototypeOf(eventRow, {
    inherited_event_field: "must_not_escape",
  });
  if (variant === "inherited_event_required") {
    Reflect.deleteProperty(eventRow, "run_id");
    Object.setPrototypeOf(eventRow, { run_id: "owned_events" });
  }
  if (variant === "invalid_payload") eventRow.payload_json = "{";
  if (variant === "invalid_runtime_record")
    Object.assign(eventRow, { runtime_record_json: '{"runId":42}' });

  const summaryRow = {
    run_id: "owned_summary",
    surface: "lab",
    environment: "local",
    app_resource_kind: "lab_run",
    app_resource_id: "owned_summary",
    diagnostic_schema_version: 1,
    runtime_controller_version: null,
    started_at: 1_700_000_000_000,
    ended_at: null,
    expires_at: 1_700_000_100_000,
    session_id: null,
    setup_failure_json: null,
    startup_json: null,
    settings_summary_json: null,
    prompt_provenance_json: null,
    completion_status: null,
    completion_review_status: null,
    completion_debug_text: null,
    unowned_summary_field: "must_not_escape",
  };
  Object.setPrototypeOf(summaryRow, {
    inherited_summary_field: "must_not_escape",
  });
  const rawSummary = { ...summaryRow, startup_json: variant === "wrong_startup_type" ? 42 : null };
  if (variant === "inherited_required") {
    Reflect.deleteProperty(rawSummary, "run_id");
    Object.setPrototypeOf(rawSummary, { run_id: "owned_summary" });
  }

  const statement: D1PreparedStatementCapability = {
    bind: () => statement,
    run: async () => ({ success: true }),
    all: async () => ({
      results: [eventRow],
      success: true,
    }),
    first: async () => (variant === "valid" ? summaryRow : rawSummary),
  };

  return {
    prepare: () => statement,
  };
}
