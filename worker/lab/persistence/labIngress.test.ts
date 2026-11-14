import { describe, expect, it } from "vitest";
import type {
  D1DatabaseCapability,
  D1PreparedStatementCapability,
} from "../../shared/persistence/runDiagnosticsD1.ts";
import { getLabStartupState } from "./labStartup.ts";
import { getLabTerminalResult } from "./labTerminalResults.ts";

function ingressDatabase(row: Readonly<Record<string, unknown>>): D1DatabaseCapability {
  return {
    prepare() {
      const statement: D1PreparedStatementCapability = {
        bind: () => statement,
        first: async () => row,
        all: async () => ({ results: [row], success: true, meta: {} }),
        run: async () => {
          throw new Error("read_only_ingress_fixture");
        },
      };
      return statement;
    },
  };
}
const startupRow = {
  run_id: "lab_ingress",
  started_at: 1000,
  startup_expires_at: 31000,
  startup_status: "pending",
  startup_decided_at: null,
  startup_reason: null,
  runtime_dispatch_intent_at: null,
  startup_stop_required: 0,
  startup_stop_acknowledged_at: null,
  startup_stop_retry_at: null,
  startup_stop_attempt_count: 0,
};
const terminalRow = {
  terminal_result_json: null,
  transcript_revision: 0,
  transcript_digest: "sha256:" + "0".repeat(64),
  transcript_turn_count: 0,
};

describe("Lab current persistence ingress", () => {
  it("returns the complete owned startup policy and rejects unowned fields", async () => {
    expect(await getLabStartupState(ingressDatabase(startupRow), "lab_ingress")).toEqual({
      runId: "lab_ingress",
      receivedAt: 1000,
      expiresAt: 31000,
      status: "pending",
      decidedAt: null,
      reason: null,
      dispatchIntentAt: null,
      stopRequired: false,
      stopAcknowledgedAt: null,
      stopRetryAt: null,
      stopAttemptCount: 0,
    });
    await expect(
      getLabStartupState(ingressDatabase({ ...startupRow, extra: true }), "lab_ingress"),
    ).rejects.toThrow();
    for (const [key, value] of Object.entries(startupRow)) {
      const missing = Object.fromEntries(
        Object.entries(startupRow).filter(([field]) => field !== key),
      );
      await expect(getLabStartupState(ingressDatabase(missing), "lab_ingress")).rejects.toThrow();
      Object.setPrototypeOf(missing, { [key]: value });
      await expect(getLabStartupState(ingressDatabase(missing), "lab_ingress")).rejects.toThrow();
      await expect(
        getLabStartupState(
          ingressDatabase({ ...startupRow, [key]: { invalid: true } }),
          "lab_ingress",
        ),
      ).rejects.toThrow();
    }
  });
  it("rejects malformed or unowned canonical result rows before exposing technical evidence", async () => {
    expect(await getLabTerminalResult(ingressDatabase(terminalRow), "lab_ingress")).toBeNull();
    for (const invalid of [
      { ...terminalRow, extra: true },
      { ...terminalRow, transcript_turn_count: "0" },
      { ...terminalRow, terminal_result_json: 42 },
      { ...terminalRow, terminal_result_json: JSON.stringify({ outcome: "completed" }) },
      {
        ...terminalRow,
        terminal_result_json: JSON.stringify({
          runId: "another_run",
          outcome: "failed_to_start",
          endedAt: 1,
          runtimeUsage: { completeness: "complete", observations: [] },
        }),
      },
    ])
      await expect(getLabTerminalResult(ingressDatabase(invalid), "lab_ingress")).rejects.toThrow();
    for (const [key, value] of Object.entries(terminalRow)) {
      const missing = Object.fromEntries(
        Object.entries(terminalRow).filter(([field]) => field !== key),
      );
      await expect(getLabTerminalResult(ingressDatabase(missing), "lab_ingress")).rejects.toThrow();
      Object.setPrototypeOf(missing, { [key]: value });
      await expect(getLabTerminalResult(ingressDatabase(missing), "lab_ingress")).rejects.toThrow();
    }
  });
});
