import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attemptRuntimePublication as publicationAttempt,
  nextPublicationRetryAt,
  type RuntimePublicationCrashPoint,
  type RuntimePublicationTarget,
} from "./runtimePublicationOutbox.ts";

/** Runs one attempt as its own owner, as a Runtime publication owner would. */
function attemptRuntimePublication(input: Parameters<typeof publicationAttempt>[0]) {
  return Effect.runPromise(publicationAttempt(input));
}

afterEach(() => vi.useRealTimers());

describe("Runtime publication outbox", () => {
  it.each(publicationTargets())(
    "injects every publication crash boundary for $kind",
    async (target) => {
      for (const point of [
        "before_request",
        "after_response_before_receipt",
      ] as const satisfies readonly RuntimePublicationCrashPoint[]) {
        const requests: string[] = [];
        await expect(
          attemptRuntimePublication({
            target,
            fetch: async (request) => {
              requests.push(await request.clone().text());
              return successfulAcknowledgement(target);
            },
            crashInjector: (observed) => {
              if (observed === point) throw new Error(`injected_crash:${point}`);
            },
          }),
        ).rejects.toThrow(`injected_crash:${point}`);
        expect(requests).toHaveLength(point === "before_request" ? 0 : 1);
      }
    },
  );

  it("constructs the current transcript payload without mutation", async () => {
    const target = transcriptTarget();
    const snapshotBefore = JSON.stringify(target);
    let request: Request | undefined;
    const result = await attemptRuntimePublication({
      target,
      fetch: async (input) => {
        request = input;
        return acknowledgement("stored", target.snapshot);
      },
    });

    expect(result).toEqual({ delivered: true });
    expect(JSON.stringify(target)).toBe(snapshotBefore);
    expect(request?.headers.get("X-Runtime-Callback")).toBe("interview-runtime-controller");
    await expect(request?.json()).resolves.toEqual({
      version: 2,
      type: "runtimeTranscriptUpdated",
      runId: "run_publication",
      snapshot: target.snapshot,
    });
  });

  it("includes response body buffering in the four-second attempt bound", async () => {
    vi.useFakeTimers();
    const resultPromise = attemptRuntimePublication({
      target: transcriptTarget(),
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      version: 2,
                      status: "stored",
                      requestedMatches: true,
                      storedSnapshot: transcriptTarget().snapshot,
                    }),
                  ),
                );
                controller.close();
              }, 4_001);
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(resultPromise).resolves.toEqual({
      delivered: false,
      error: "callback_timed_out",
      disposition: "retryable",
    });
  });

  it("accepts a delayed matching receipt before the attempt bound", async () => {
    vi.useFakeTimers();
    const target = transcriptTarget();
    const resultPromise = attemptRuntimePublication({
      target,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_999));
        return acknowledgement("stored", target.snapshot);
      },
    });
    await vi.advanceTimersByTimeAsync(3_999);
    await expect(resultPromise).resolves.toEqual({ delivered: true });
  });

  it("classifies retryable and nonretryable HTTP failures", async () => {
    await expect(
      attemptRuntimePublication({
        target: transcriptTarget(),
        fetch: async () => new Response("unavailable", { status: 503 }),
      }),
    ).resolves.toMatchObject({ delivered: false, disposition: "retryable" });
    await expect(
      attemptRuntimePublication({
        target: transcriptTarget(),
        fetch: async () => new Response("bad request", { status: 400 }),
      }),
    ).resolves.toMatchObject({
      delivered: false,
      disposition: "blocked_nonretryable_callback",
    });
  });

  it("blocks explicit conflicts and mismatched success receipts", async () => {
    const target = transcriptTarget();
    await expect(
      attemptRuntimePublication({
        target,
        fetch: async () => acknowledgement("conflict", target.snapshot, 409, false),
      }),
    ).resolves.toMatchObject({
      delivered: false,
      disposition: "blocked_snapshot_conflict",
    });
    await expect(
      attemptRuntimePublication({
        target,
        fetch: async () =>
          acknowledgement("stored", { ...target.snapshot, digest: `sha256:${"b".repeat(64)}` }),
      }),
    ).resolves.toMatchObject({
      delivered: false,
      disposition: "blocked_snapshot_conflict",
    });
  });

  it("retains malformed acknowledgement rejection", async () => {
    const target = transcriptTarget();
    for (const payload of [
      null,
      [],
      { ok: "yes" },
      { version: 2, status: "stored", requestedMatches: "yes", storedSnapshot: target.snapshot },
      {
        version: 2,
        status: "stored",
        requestedMatches: true,
        storedSnapshot: { ...target.snapshot, revision: -1 },
      },
    ]) {
      await expect(
        attemptRuntimePublication({
          target,
          fetch: async () => Response.json(payload),
        }),
      ).resolves.toEqual({
        delivered: false,
        error: "callback_invalid_ack",
        disposition: "blocked_nonretryable_callback",
      });
    }
  });

  it.each(["participant_stopped", "timebox_reached"] as const)(
    "classifies canonical %s receipts without dual publication",
    async (reason) => {
      const target = publicationTargets().find(
        (entry) => entry.kind === "completed" && entry.result.reason === reason,
      );
      if (target?.kind !== "completed") throw new Error("missing_completed_target");
      for (const [status, httpStatus, expected] of [
        ["completed", 200, { delivered: true }],
        ["idempotent", 200, { delivered: true }],
        ["snapshot_missing", 503, { delivered: false, disposition: "retryable" }],
        ["snapshot_mismatch", 409, { delivered: false, disposition: "blocked_snapshot_conflict" }],
      ] as const) {
        const result = await attemptRuntimePublication({
          target,
          fetch: async (request) => {
            expect(await request.json()).toEqual(target.result);
            return acknowledgement(status, target.result.transcriptSnapshot, httpStatus);
          },
        });
        expect(result).toMatchObject(expected);
      }
    },
  );

  it("proposes capped retries only for retryable failures", () => {
    expect(nextPublicationRetryAt(1_000, 0, "retryable")).toBe(11_000);
    expect(nextPublicationRetryAt(1_000, 20, "retryable")).toBe(601_000);
    expect(nextPublicationRetryAt(1_000, 0, "blocked_snapshot_conflict")).toBeNull();
    expect(nextPublicationRetryAt(1_000, 0, "blocked_nonretryable_callback")).toBeNull();
    expect(nextPublicationRetryAt(1_000, 0, "retryable", 30_000)).toBe(3_000);
    expect(nextPublicationRetryAt(27_000, 4, "retryable", 30_000)).toBeNull();
  });

  it("dispatches nothing with an exhausted budget", async () => {
    const requests: Request[] = [];
    expect(
      await attemptRuntimePublication({
        target: transcriptTarget(),
        timeoutMs: 0,
        fetch: async (request) => {
          requests.push(request);
          return successfulAcknowledgement(transcriptTarget());
        },
      }),
    ).toEqual({ delivered: false, error: "callback_timed_out", disposition: "retryable" });
    expect(requests).toEqual([]);
  });

  it("clamps a callback transport timeout to the supplied remaining budget", async () => {
    vi.useFakeTimers();
    const resultPromise = attemptRuntimePublication({
      target: transcriptTarget(),
      timeoutMs: 500,
      fetch: async () => await new Promise<Response>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(resultPromise).resolves.toMatchObject({
      delivered: false,
      error: "callback_timed_out",
      disposition: "retryable",
    });
  });
});

function transcriptTarget(): Extract<RuntimePublicationTarget, { kind: "transcript" }> {
  return {
    kind: "transcript",
    runId: "run_publication",
    snapshot: {
      revision: 3,
      digest: `sha256:${"a".repeat(64)}`,
      turnCount: 1,
      transcript: { turns: [{ role: "participant", text: "Hello" }] },
    },
  };
}

function publicationTargets(): RuntimePublicationTarget[] {
  const transcript = transcriptTarget();
  const transcriptSnapshot = transcript.snapshot;
  return [
    transcript,
    ...(["participant_stopped", "timebox_reached"] as const).map((reason) => ({
      kind: "completed" as const,
      result: {
        outcome: "completed" as const,
        reason,
        runId: "run_publication",
        liveAt: 100,
        endedAt: 200,
        transcriptSnapshot: {
          revision: transcriptSnapshot.revision,
          digest: transcriptSnapshot.digest,
          turnCount: transcriptSnapshot.turnCount,
        },
        transcriptCompleteness: "complete" as const,
        transcriptIncompleteReasons: [],
        runtimeUsage: { completeness: "complete" as const, observations: [] },
      },
    })),
    {
      kind: "completion",
      completion: {
        runId: "run_publication",
        outcome: "ended",
        endReason: "participant_stopped",
        source: "browser_request",
        endingStartedAt: 100,
        endedAt: 200,
        finalizationCutoffAt: 10_100,
        finalizedAt: 200,
        transcriptSnapshot: {
          revision: transcriptSnapshot.revision,
          digest: transcriptSnapshot.digest,
          turnCount: transcriptSnapshot.turnCount,
        },
        warnings: [],
      },
    },
  ];
}

function successfulAcknowledgement(target: RuntimePublicationTarget): Response {
  if (target.kind === "failed_to_start") return Response.json({ ok: true });
  const snapshot =
    target.kind === "transcript"
      ? target.snapshot
      : target.kind === "interrupted" || target.kind === "completed"
        ? target.result.transcriptSnapshot
        : target.completion.transcriptSnapshot;
  return Response.json({
    version: 2,
    status: target.kind === "transcript" ? "stored" : "completed",
    requestedMatches: true,
    storedSnapshot: snapshot,
  });
}

function acknowledgement(
  status: string,
  snapshot: Readonly<{ revision: number; digest: string; turnCount: number }>,
  httpStatus = 200,
  requestedMatches = true,
): Response {
  return Response.json(
    {
      version: 2,
      status,
      requestedMatches,
      storedSnapshot: snapshot,
    },
    { status: httpStatus },
  );
}
