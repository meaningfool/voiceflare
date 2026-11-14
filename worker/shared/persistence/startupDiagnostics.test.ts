import { describe, expect, it } from "vitest";
import {
  decodeBrowserStartup,
  decodeStartupCallback,
  decodeStartupObservation,
  decodeStoredStartup,
  summarizeStartup,
} from "../contracts/startupDiagnostics.ts";
import { createTestLabD1Database } from "../testing/d1.ts";
import {
  ensureRunDiagnosticSummary,
  getRunDiagnosticSummary,
  purgeExpiredRunDiagnosticEvents,
  runDiagnosticEventRetentionMs,
} from "./runDiagnosticsD1.ts";
import { readStartupSummary, recordStartupObservation } from "./startupDiagnostics.ts";

describe("startup diagnostic contracts", () => {
  it.each([-1, 11, "10", { count: 10 }])("rejects invalid stored resolution count %j", (count) => {
    expect(() =>
      decodeStoredStartup({ stages: {}, failures: {}, acceptanceResolutionAttemptCount: count }),
    ).toThrow();
  });
  it("retains the bounded stored resolution count", () => {
    expect(
      summarizeStartup(
        decodeStoredStartup({ stages: {}, failures: {}, acceptanceResolutionAttemptCount: 10 }),
      ).acceptanceResolutionAttemptCount,
    ).toBe(10);
  });
  it("derives separate acceptance, setup and browser durations, without cross-browser clock subtraction", () => {
    const summary = summarizeStartup({
      stages: {
        browserStarted: 100,
        requestSent: 200,
        connectionReplyReceived: 900,
        connectionReplyApplied: 910,
        browserReady: 950,
        responseCreated: 10000,
        runtimeDispatched: 10010,
        runtimeAccepted: 10030,
        liveAt: 10700,
      },
      failures: {},
    });
    expect(summary).toMatchObject({
      outcome: "live",
      lastStage: "browserReady",
      durationsMs: {
        dispatchToAcceptance: 20,
        runtimeSetup: 670,
        participantPerceivedStartup: 850,
        browserReplyWait: 700,
      },
    });
    expect(
      summarizeStartup({ stages: { runtimeDispatched: 20, runtimeAccepted: 10 }, failures: {} })
        .durationsMs.dispatchToAcceptance,
    ).toBeNull();
  });

  it.each([
    {},
    { stage: "providerCreated" },
    { stage: 42, at: 10 },
    { stage: "providerCreated", at: "10" },
    { stage: "providerCreated", at: -1 },
    { stage: "providerCreated", at: 10, cleanup: { status: "done" } },
  ])("rejects invalid observation consumer fields: %j", (value) => {
    expect(() => decodeStartupObservation(value)).toThrow();
    expect(() => decodeStartupCallback({ runId: "r", observation: value })).toThrow();
  });

  it("strips payloads and inherited fields, and rejects inherited required fields", () => {
    const observation = {
      stage: "providerCreated",
      at: 10,
      sdp: "secret",
      transcript: "secret",
      audio: "secret",
      providerPayload: { secret: true },
    };
    expect(decodeStartupObservation(observation)).toEqual({ stage: "providerCreated", at: 10 });
    expect(decodeStartupCallback({ runId: "r", observation, extra: "secret" })).toEqual({
      runId: "r",
      observation: { stage: "providerCreated", at: 10 },
    });
    expect(() =>
      decodeStartupObservation(Object.create({ stage: "providerCreated", at: 10 })),
    ).toThrow();
    expect(() => decodeStartupCallback(Object.create({ runId: "r", observation }))).toThrow();
    expect(
      decodeStartupObservation(
        Object.assign(Object.create({ extra: "secret" }), { stage: "providerCreated", at: 10 }),
      ),
    ).toEqual({ stage: "providerCreated", at: 10 });
  });

  it("restricts browser reports and validates persisted nested timestamps", () => {
    expect(
      decodeBrowserStartup([{ stage: "connectionReplyApplied", at: 12, sdp: "secret" }]),
    ).toEqual([{ stage: "connectionReplyApplied", at: 12 }]);
    expect(() => decodeBrowserStartup([{ stage: "liveAt", at: 12 }])).toThrow();
    expect(() => decodeBrowserStartup([{ stage: "connectionReplyApplied", at: "12" }])).toThrow();
    expect(() => decodeStoredStartup({ stages: { liveAt: "12" }, failures: {} })).toThrow();
    expect(() =>
      decodeStoredStartup({ stages: {}, failures: { providerCreated: { at: 12 } } }),
    ).toThrow();
    expect(() => decodeStoredStartup({ failures: {} })).toThrow();
    expect(() => decodeStartupCallback({ observation: { stage: "liveAt", at: 12 } })).toThrow();
    expect(() =>
      decodeStartupCallback({ runId: 42, observation: { stage: "liveAt", at: 12 } }),
    ).toThrow();
    expect(() =>
      decodeBrowserStartup([Object.create({ stage: "connectionReplyApplied", at: 12 })]),
    ).toThrow();
    expect(() => decodeStoredStartup(Object.create({ stages: {}, failures: {} }))).toThrow();
    expect(decodeStoredStartup({ stages: {}, failures: {}, transcript: "secret" })).toEqual({
      stages: {},
      failures: {},
    });
    const failed = summarizeStartup({
      stages: { providerRequested: 100 },
      failures: {
        providerCreated: { stage: "providerCreated", at: 150, failure: true, cleanup: "unknown" },
      },
    });
    expect(failed.failureAt).toBe(150);
    expect(failed.durationsMs.failedStage).toBe(50);
  });

  it("correlates partial callbacks, preserves first stages and retains summary after event expiry", async () => {
    const database = createTestLabD1Database();
    try {
      for (const runId of ["run_a", "run_b"])
        await ensureRunDiagnosticSummary(database.d1, {
          runId,
          surface: "product",
          appResourceKind: "interview_response",
          appResourceId: runId,
          startedAt: 100,
        });
      await recordStartupObservation(database.d1, "run_a", { stage: "runtimeAccepted", at: 150 });
      await recordStartupObservation(database.d1, "run_a", { stage: "runtimeDispatched", at: 120 });
      await recordStartupObservation(database.d1, "run_a", { stage: "runtimeAccepted", at: 999 });
      await recordStartupObservation(database.d1, "run_a", {
        stage: "providerCreated",
        at: 200,
        failure: true,
        cleanup: "unknown",
      });
      await purgeExpiredRunDiagnosticEvents(database.d1, {
        now: Date.now() + runDiagnosticEventRetentionMs,
      });
      const row = await getRunDiagnosticSummary(database.d1, "run_a");
      if (row === null) throw new Error("missing summary");
      expect(readStartupSummary(row.startup_json)).toMatchObject({
        outcome: "failed",
        lastStage: "runtimeAccepted",
        failureStage: "providerCreated",
        cleanupStatus: "unknown",
        durationsMs: { dispatchToAcceptance: 30, runtimeSetup: null },
      });
      expect((await getRunDiagnosticSummary(database.d1, "run_b"))?.startup_json).toBeNull();
      expect((await database.d1.prepare("SELECT * FROM runtime_events").all()).results).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("expires startup events after receipt even when the browser clock is far ahead", async () => {
    const database = createTestLabD1Database();
    const receivedAt = Date.now();
    const browserAt = receivedAt + 365 * 24 * 60 * 60 * 1000;
    try {
      await ensureRunDiagnosticSummary(database.d1, {
        runId: "future_browser_clock",
        surface: "product",
        appResourceKind: "interview_response",
        appResourceId: "future_browser_clock",
        startedAt: receivedAt,
      });
      await recordStartupObservation(database.d1, "future_browser_clock", {
        stage: "browserStarted",
        at: browserAt,
      });
      await purgeExpiredRunDiagnosticEvents(database.d1, {
        now: Date.now() + runDiagnosticEventRetentionMs,
      });
      expect((await database.d1.prepare("SELECT * FROM runtime_events").all()).results).toEqual([]);
      const row = await getRunDiagnosticSummary(database.d1, "future_browser_clock");
      if (row === null) throw new Error("missing summary");
      expect(readStartupSummary(row.startup_json)?.stages.browserStarted).toBe(browserAt);
    } finally {
      database.close();
    }
  });
});
