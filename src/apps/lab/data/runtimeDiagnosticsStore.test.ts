import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createWorkerRuntimeDiagnosticsStore } from "./runtimeDiagnosticsStore";

describe("Runtime diagnostics store", () => {
  it("writes runtime metadata through narrow intent-shaped Worker methods", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      return Promise.resolve(Response.json({ ok: true }));
    });
    const store = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", { fetchImpl });

    await store.recordProviderCall({
      runId: "run-1",
      sessionId: "rtc_provider_call",
    });
    await store.recordSetupFailure({
      runId: "run-1",
      failureKind: "session_setup",
      source: "runtime_controller",
      errorText: "Provider/signaling failed: sideband could not attach.",
    });
    await store.recordCompletionDiagnostics({
      runId: "run-1",
      completionStatus: "sidebandClosed",
      completionReviewStatus: "clean",
      completionDebugText: "Final Transcript persistence observed with 2 turns.",
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8795/_api/runs/run-1/diagnostics",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          sessionId: "rtc_provider_call",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8795/_api/runs/run-1/diagnostics",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          setupFailure: {
            failureKind: "session_setup",
            source: "runtime_controller",
            errorText: "Provider/signaling failed: sideband could not attach.",
          },
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8795/_api/runs/run-1/diagnostics",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          completionStatus: "sidebandClosed",
          completionReviewStatus: "clean",
          completionDebugText: "Final Transcript persistence observed with 2 turns.",
        }),
      }),
    );
  });

  it("reads run diagnostics separately from Runtime Events", async () => {
    const diagnostics = {
      runId: "run-1",
      startedAt: 1_700_000_000_000,
      sessionId: "rtc_provider_call",
      settingsSummary: {
        model: "gpt-realtime-2",
        voice: "marin",
        maxOutputTokens: 700,
      },
      completionStatus: "sidebandClosed" as const,
      completionDebugText: "Final Transcript persistence observed with 2 turns.",
    };
    const evidence = [
      {
        runId: "run-1",
        observedAt: 1_700_000_000_000,
        sequence: 1,
        elapsedMs: 120,
        type: "response.done",
        payloadJson: '{"type":"response.done"}',
      },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(diagnostics))
      .mockResolvedValueOnce(Response.json(evidence));
    const store = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", { fetchImpl });

    await expect(store.getRunDiagnostics("run-1")).resolves.toEqual(diagnostics);
    await expect(store.listRuntimeEvents("run-1")).resolves.toEqual(evidence);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8795/_api/runs/run-1/diagnostics",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8795/_api/runs/run-1/runtime-events",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads current and historical prompt provenance while rejecting malformed nested values", async () => {
    const base = { runId: "run-1", startedAt: 1_700_000_000_000 };
    for (const promptProvenance of [
      { promptId: "saved", contentHash: "hash" },
      { promptId: "saved", promptFileName: "saved.md", contentHash: "hash" },
    ]) {
      const store = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", {
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ ...base, promptProvenance })),
      });
      await expect(store.getRunDiagnostics("run-1")).resolves.toMatchObject({
        promptProvenance,
      });
    }
    const invalidStore = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          ...base,
          promptProvenance: { promptId: "saved", contentHash: 42 },
        }),
      ),
    });
    await expect(invalidStore.getRunDiagnostics("run-1")).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for GET /_api/runs/run-1/diagnostics.",
    );
  });

  it("keeps browser observations outside the authoritative Runtime namespace", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ stored: true, reason: "lab", storedCount: 1 }),
      );
    const store = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", { fetchImpl });
    await store.recordLiveDegradation({
      runId: "run-1",
      source: "browser",
      degradationKind: "browser_runtime_event_stream",
    });
    await store.recordEndingStarted({
      runId: "run-1",
      source: "browser",
      endReason: "participant_stopped",
    });
    await store.recordFinalTurnFlushFinished({ runId: "run-1", status: "timedOut" });
    const bodies = fetchImpl.mock.calls.map((call) =>
      z
        .object({ records: z.array(z.object({ type: z.string(), payloadJson: z.string() })) })
        .parse(JSON.parse(String(call[1]?.body))),
    );
    expect(bodies.map((body) => body.records[0]?.type)).toEqual([
      "browser.live_degraded",
      "browser.ending_started",
      "browser.final_turn_flush_finished",
    ]);
  });
  it("retains authoritative attribution when reading the Run Event Log", async () => {
    const runtimeRecord = {
      recordId: "run-1:1",
      runId: "run-1",
      source: "conversation",
      selection: {
        conversation: { id: "goodbye-interview", version: 1 },
        execution: { id: "realtime", version: 1 },
      },
      visitId: "visit",
      operationId: "operation",
      observedAt: 1000,
      sequence: 1,
      elapsedMs: 100,
      type: "conversation.closing_assessment",
      payloadJson: '{"warnings":[],"finalizedAt":1000,"endReason":"timebox_reached"}',
    };
    const event = {
      runId: runtimeRecord.runId,
      observedAt: 1000,
      sequence: 1,
      elapsedMs: 100,
      type: runtimeRecord.type,
      payloadJson: runtimeRecord.payloadJson,
      runtimeRecord,
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([event]));
    const store = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", { fetchImpl });
    expect(await store.listRuntimeEvents("run-1")).toEqual([event]);
  });

  it("appends Runtime Events through Lab's runtime-events route", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ stored: true, reason: "lab", storedCount: 1 }));
    const store = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", { fetchImpl });

    await store.appendRuntimeEvents({
      runId: "run-1",
      records: [
        {
          runId: "run-1",
          observedAt: 1_700_000_000_000,
          sequence: 1,
          elapsedMs: 120,
          type: "response.done",
          payloadJson: '{"type":"response.done"}',
        },
      ],
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8795/_api/runs/run-1/runtime-events",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          records: [
            {
              observedAt: 1_700_000_000_000,
              sequence: 1,
              elapsedMs: 120,
              type: "response.done",
              payloadJson: '{"type":"response.done"}',
            },
          ],
        }),
      }),
    );
  });

  it("rejects malformed successful diagnostics responses with endpoint-owned errors", async () => {
    const diagnosticsStore = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", {
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ runId: "run-1", startedAt: "unchecked" })),
    });
    await expect(diagnosticsStore.getRunDiagnostics("run-1")).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for GET /_api/runs/run-1/diagnostics.",
    );

    const eventsStore = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json([
          {
            runId: "run-1",
            observedAt: 1_700_000_000_000,
            sequence: 1,
            elapsedMs: 120,
            type: "response.done",
            payloadJson: {},
          },
        ]),
      ),
    });
    await expect(eventsStore.listRuntimeEvents("run-1")).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for GET /_api/runs/run-1/runtime-events.",
    );

    const patchStore = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: "true" })),
    });
    await expect(
      patchStore.recordProviderCall({
        runId: "run-1",
        sessionId: "rtc_provider_call",
      }),
    ).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for PATCH /_api/runs/run-1/diagnostics.",
    );

    const appendStore = createWorkerRuntimeDiagnosticsStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          stored: true,
          reason: "lab",
          storedCount: "1",
        }),
      ),
    });
    await expect(appendStore.appendRuntimeEvents({ runId: "run-1", records: [] })).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for POST /_api/runs/run-1/runtime-events.",
    );
  });
});
