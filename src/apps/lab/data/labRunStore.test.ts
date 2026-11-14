import { describe, expect, it, vi } from "vitest";

import { createInterviewPromptProvenance } from "./interviewPrompt";
import { createWorkerLabRunStore, readLabOutcome, decodeLabRunDetail } from "./labRunStore";

describe("Lab run store", () => {
  it("creates Lab Runs through the Lab Worker and keeps prompt provenance out of the returned run identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          runId: "run-1",
          startedAt: 1_700_000_000_000,
        },
        {
          status: 201,
        },
      ),
    );
    const store = createWorkerLabRunStore("http://127.0.0.1:8795", { fetchImpl });
    const promptProvenance = createInterviewPromptProvenance({
      promptId: "sample-prompt",
      content: "Sample prompt",
    });

    await expect(
      store.createLabRun({
        promptProvenance,
      }),
    ).resolves.toEqual({
      runId: "run-1",
      startedAt: 1_700_000_000_000,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8795/_api/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          promptProvenance,
        }),
      }),
    );
  });

  it("records setup failure through its intent-shaped Worker route", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      return Promise.resolve(Response.json({ ok: true }));
    });
    const store = createWorkerLabRunStore("http://127.0.0.1:8795", { fetchImpl });

    await store.recordSetupFailureEnd({
      runId: "run-1",
      endedAt: 1_700_000_030_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8795/_api/runs/run-1/setup-failure",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          endedAt: 1_700_000_030_000,
        }),
      }),
    );
  });

  it("lists and opens clean Lab Run projections", async () => {
    const list = [
      {
        runId: "run-1",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_030_000,
        outcome: "ended" as const,
        endReason: "participant_stopped" as const,
        transcriptTurnCount: 1,
      },
    ];
    const detail = {
      ...list[0],
      executionModel: "gpt-realtime-2.1",
      maxOutputTokens: 1024,
      responseUsage: [
        { responseId: "resp_1", outputTokens: 81, model: "gpt-realtime-2.1", answerTurnNumber: 1 },
      ],
      transcript: {
        turns: [
          {
            role: "participant" as const,
            text: "It worked.",
          },
        ],
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(list))
      .mockResolvedValueOnce(Response.json(detail));
    const store = createWorkerLabRunStore("http://127.0.0.1:8795", { fetchImpl });

    await expect(store.listLabRuns()).resolves.toEqual(list);
    await expect(store.getLabRun("run-1")).resolves.toEqual(detail);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8795/_api/runs",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8795/_api/runs/run-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns null when the Worker reports a missing Lab Run", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "lab_run_not_found" }, { status: 404 }));
    const store = createWorkerLabRunStore("http://127.0.0.1:8795", { fetchImpl });

    await expect(store.getLabRun("missing")).resolves.toBeNull();
  });

  it("rejects malformed successful Lab Run responses with endpoint-owned errors", async () => {
    const createStore = createWorkerLabRunStore("http://127.0.0.1:8795", {
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ runId: "run-1", startedAt: "unchecked" })),
    });
    await expect(createStore.createLabRun()).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for POST /_api/runs.",
    );

    const listStore = createWorkerLabRunStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json([
          {
            runId: "run-1",
            startedAt: 1_700_000_000_000,
            transcriptTurnCount: 0,
            callerSelected: true,
          },
        ]),
      ),
    });
    await expect(listStore.listLabRuns()).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for GET /_api/runs.",
    );

    const detailStore = createWorkerLabRunStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          runId: "run-1",
          startedAt: 1_700_000_000_000,
          transcriptTurnCount: 1,
          transcript: { turns: [{ role: "system", text: "Unchecked role" }] },
        }),
      ),
    });
    await expect(detailStore.getLabRun("run-1")).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for GET /_api/runs/run-1.",
    );

    const malformedUsageStore = createWorkerLabRunStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          runId: "run-1",
          startedAt: 1_700_000_000_000,
          transcriptTurnCount: 0,
          transcript: { turns: [] },
          responseUsage: [{ responseId: "resp_1", outputTokens: "81" }],
        }),
      ),
    });
    await expect(malformedUsageStore.getLabRun("run-1")).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for GET /_api/runs/run-1.",
    );

    const setupFailureStore = createWorkerLabRunStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false })),
    });
    await expect(
      setupFailureStore.recordSetupFailureEnd({
        runId: "run-1",
        endedAt: 1_700_000_030_000,
      }),
    ).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for PATCH /_api/runs/run-1/setup-failure.",
    );
  });

  it("normalizes malformed JSON from successful Lab Worker responses", async () => {
    const store = createWorkerLabRunStore("http://127.0.0.1:8795", {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });

    await expect(store.listLabRuns()).rejects.toThrow(
      "Interview Lab Worker returned an invalid response for GET /_api/runs.",
    );
  });
});

describe("Lab canonical outcome reads", () => {
  const detail = {
    runId: "lab_retained",
    startedAt: 100,
    transcriptTurnCount: 0,
    transcript: { turns: [] },
  };
  const failed = {
    runId: "lab_retained",
    outcome: "failed_to_start",
    endedAt: 150,
    runtimeUsage: { completeness: "complete", observations: [] },
  };
  it("does not accept inherited record or nested terminal fields", () => {
    const ownDetail = { ...detail };
    Reflect.deleteProperty(ownDetail, "runId");
    expect(() =>
      decodeLabRunDetail(Object.assign(Object.create({ runId: "lab_retained" }), ownDetail)),
    ).toThrow();
    const ownTerminal = { ...failed };
    Reflect.deleteProperty(ownTerminal, "runtimeUsage");
    const inheritedTerminal: unknown = Object.assign(
      Object.create({ runtimeUsage: failed.runtimeUsage }),
      ownTerminal,
    );
    expect(() => decodeLabRunDetail({ ...detail, terminalResult: inheritedTerminal })).toThrow();
    expect(
      decodeLabRunDetail(
        Object.assign(Object.create({ ignored: true }), { ...detail, terminalResult: failed }),
      ),
    ).not.toHaveProperty("ignored");
  });
  it("retains failed startup without inventing live evidence", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...detail, terminalResult: failed }));
    await expect(
      readLabOutcome({
        endpointBaseUrl: "https://lab.test",
        runId: "lab_retained",
        timeoutMs: 2000,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ terminalResult: failed });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://lab.test/_api/runs/lab_retained",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
  it("bounds a stalled result transport independently of participation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(
      readLabOutcome({
        endpointBaseUrl: "https://lab.test",
        runId: "lab_retained",
        timeoutMs: 10,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("preserves actual live timing when startup failed in the browser", async () => {
    const terminalResult = {
      runId: "lab_retained",
      outcome: "interrupted",
      liveAt: 120,
      endedAt: 150,
      transcriptSnapshot: { revision: 0, digest: "sha256:" + "a".repeat(64), turnCount: 0 },
      transcriptCompleteness: "complete",
      transcriptIncompleteReasons: [],
      runtimeUsage: { completeness: "complete", observations: [] },
    };
    const store = createWorkerLabRunStore("https://lab.test", {
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ...detail, terminalResult })),
    });
    await expect(store.getLabRun("lab_retained")).resolves.toMatchObject({ terminalResult });
  });
  it.each([
    { ...failed, endedAt: "unchecked" },
    { ...failed, runId: "lab_replacement" },
    { ...failed, runtimeUsage: { completeness: "complete", observations: [{ quantity: "bad" }] } },
    { ...failed, liveAt: 120 },
  ])("rejects malformed or unrelated terminal evidence", async (terminalResult) => {
    const store = createWorkerLabRunStore("https://lab.test", {
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ...detail, terminalResult })),
    });
    await expect(store.getLabRun("lab_retained")).rejects.toThrow("invalid response");
  });
});

it("validates Lab-owned closing diagnostic state without changing canonical terminal data", () => {
  const run = { runId: "run", startedAt: 1000, transcriptTurnCount: 0, transcript: { turns: [] } };
  expect(
    decodeLabRunDetail({
      ...run,
      closingDiagnostic: { status: "limited", warnings: ["closing_interrupted"] },
    }).closingDiagnostic,
  ).toEqual({ status: "limited", warnings: ["closing_interrupted"] });
  for (const closingDiagnostic of [
    { status: "limited", warnings: [] },
    { status: "unknown", warnings: ["closing_interrupted"] },
    { status: "limited", warnings: ["made_up"] },
    { status: "successful", warnings: [] },
  ])
    expect(() => decodeLabRunDetail({ ...run, closingDiagnostic })).toThrow();
});
