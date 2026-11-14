import { applicationCallbacks } from "./testing/applicationCallbacks.ts";
import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionBridge } from "./runtimeHostAssembly.ts";

import { createRuntimeTranscriptSnapshot } from "../shared/runtimeTranscriptSnapshot.ts";
import {
  type InterviewFinalizationAggregate,
  type RuntimeFinalizationCompletion,
  type RuntimePublicationState,
} from "./interviewFinalizationModel.ts";
import {
  RuntimePublication,
  type RuntimePublicationBackgroundWork,
  type RuntimePublicationRecord,
  type RuntimePublicationStorage,
} from "./runtimePublication.ts";
import type {
  RuntimeDiagnosticOptions,
  RuntimeDiagnosticRecord,
  RuntimeEventPayload,
} from "./runtimeEvents.ts";
import type { RuntimePublicationEvents } from "./runtimePublication.ts";

type RuntimePublicationTransports = Readonly<{
  override?: import("./types.ts").RuntimeFetchBinding;
  application?: ApplicationCallbacks;
}>;
import { deliverBoundedCallback, type ApplicationCallbacks } from "./applicationCallbacks.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Runtime Publication", () => {
  it("starts no failed-start callback at its persisted cutoff", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    const fetch = vi.fn(successfulCallbackResponse);
    const publication = fixture.publication(
      { application: applicationCallbacks({ fetch }) },
      { now: () => 32_000 },
    );

    await expect(
      Effect.runPromise(
        publication.deliverFailedStart({
          result: failedToStartResult(),
          deliveryTargetJson: fixture.record.deliveryTargetJson,
          diagnosticsContextJson: JSON.stringify({ surface: "test" }),
          publicationCutoffAt: 32_000,
        }),
      ),
    ).resolves.toEqual({ expired: true, cutoffAt: 32_000 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses only the remaining failed-start publication period for transport", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(31_500);
    const fixture = await publicationFixture({ surface: "test" });
    const fetch = vi.fn(async () => await new Promise<Response>(() => undefined));
    const publication = fixture.publication(
      { application: applicationCallbacks({ fetch }) },
      { now: () => Date.now() },
    );
    const delivery = Effect.runPromise(
      publication.deliverFailedStart({
        result: failedToStartResult(),
        deliveryTargetJson: fixture.record.deliveryTargetJson,
        diagnosticsContextJson: JSON.stringify({ surface: "test" }),
        publicationCutoffAt: 32_000,
      }),
    );

    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(delivery).resolves.toEqual({
      delivered: false,
      error: "callback_timed_out",
      disposition: "retryable",
    });
  });

  it("aborts the in-flight callback transport when its publication owner is interrupted", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const signals: AbortSignal[] = [];
    // The host bridge interrupts the fibers it owns when it is disposed.
    const owners: Array<Fiber.Fiber<unknown>> = [];
    const execution: Pick<ExecutionBridge, "run" | "runExit"> = {
      run: (operation) => {
        const owner = Effect.runFork(operation);
        owners.push(owner);
        return Effect.runPromise(Fiber.join(owner));
      },
      runExit: (operation) => Effect.runPromiseExit(operation),
    };
    const publication = fixture.publication(
      {
        override: {
          fetch: (request) => {
            signals.push(request.signal);
            return new Promise<Response>(() => undefined);
          },
        },
      },
      { execution },
    );
    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2_000,
    });
    if (!schedule.scheduled) throw new Error("Expected terminal publication to be scheduled.");
    const settled = schedule.task.then(
      () => "completed",
      () => "interrupted",
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const [owner] = owners;
    if (owner === undefined) throw new Error("Expected a publication owner fiber.");

    await Effect.runPromise(Fiber.interrupt(owner));

    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    await expect(settled).resolves.toBe("interrupted");
  });

  it("uses the explicit callback transport before the surface binding", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    const overrideFetch = vi.fn(successfulCallbackResponse);
    const applicationFetch = vi.fn(successfulCallbackResponse);
    const publication = fixture.publication({
      override: { fetch: overrideFetch },
      application: applicationCallbacks({ fetch: applicationFetch }),
    });

    await expect(publication.deliverCurrentTranscript()).resolves.toMatchObject({
      status: "delivered",
    });

    expect(overrideFetch).toHaveBeenCalledOnce();
    expect(applicationFetch).not.toHaveBeenCalled();
  });

  it("retains the missing application transport failure", async () => {
    const fixture = await publicationFixture({ surface: "lab" });
    const publication = fixture.publication({});

    await expect(publication.deliverCurrentTranscript()).resolves.toEqual({
      status: "failed",
      stored: false,
      error: "runtime_delivery_unconfigured",
      disposition: "retryable",
    });
  });

  it("keeps a sealed pre-migration application proof on its pending legacy publication", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = {
      ...fixture.record,
      aggregate: {
        ...fixture.record.aggregate,
        applicationTranscriptProof: {
          liveAt: 100,
          interrupted: false,
          obligations: [{ itemId: "legacy", role: "participant", status: "captured" }],
          closeBarrier: null,
          result: null,
        },
      },
    };
    const requests: unknown[] = [];
    const publication = fixture.publication({
      application: applicationCallbacks({
        fetch: async (request) => {
          requests.push(await request.clone().json());
          return successfulCallbackResponse(request);
        },
      }),
    });
    const scheduled = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2000,
    });
    if (!scheduled.scheduled) throw new Error("expected_publication");
    expect(await scheduled.task).toMatchObject({ status: "delivered" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      version: 2,
      type: "runtimeCompleted",
      completion: fixture.completion,
    });
    expect(fixture.storage.record?.aggregate.applicationTranscriptProof?.result).toBeNull();
  });

  it("delivers the frozen Transcript before completion and persists both state changes", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    const callbackKinds: string[] = [];
    const publication = fixture.publication({
      application: applicationCallbacks({
        fetch: async (request) => {
          const body = await readObject(request);
          callbackKinds.push(requireString(body.type));
          return successfulCallbackResponse(request);
        },
      }),
    });

    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2_000,
    });

    expect(schedule.scheduled).toBe(true);
    if (!schedule.scheduled) throw new Error("Expected terminal publication to be scheduled.");
    await expect(schedule.task).resolves.toEqual({ status: "delivered", deliveredAt: 3_000 });
    expect(callbackKinds).toEqual(["runtimeTranscriptUpdated", "runtimeCompleted"]);
    expect(fixture.storage.persisted).toHaveLength(2);
    expect(publicationOf(fixture.storage.persisted[0])).toMatchObject({
      transcriptDelivered: true,
      completionDelivered: false,
      attemptCount: 0,
    });
    expect(publicationOf(fixture.storage.record?.aggregate)).toEqual({
      status: "delivered",
      publicationCutoffAt: 32_000,
      transcriptDelivered: true,
      completionDelivered: true,
      retryAt: null,
      attemptCount: 1,
      deliveredAt: 3_000,
      lastError: null,
    });
    expect(fixture.alarmRecomputations).toBe(1);
  });

  it("suppresses concurrent terminal schedules while one delivery is in flight", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    let resolveResponse: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const callbackFetch = vi.fn((_request: Request) => response);
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const publication = fixture.publication({
      application: applicationCallbacks({ fetch: callbackFetch }),
    });

    const first = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2_000,
    });
    const duplicate = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2_000,
    });

    expect(first.scheduled).toBe(true);
    expect(duplicate).toEqual({ scheduled: false, reason: "in_flight" });
    await vi.waitFor(() => expect(callbackFetch).toHaveBeenCalledOnce());
    const callbackRequest = callbackFetch.mock.calls[0]?.[0];
    if (callbackRequest === undefined) throw new Error("Expected a callback request.");
    resolveResponse(await successfulCallbackResponse(callbackRequest));
    if (!first.scheduled) throw new Error("Expected terminal publication to be scheduled.");
    await expect(first.task).resolves.toMatchObject({ status: "delivered" });
    expect(fixture.alarmRecomputations).toBe(1);
  });

  it("observes a canonical-read failure and still requests the durable wake-up", async () => {
    const fixture = await publicationFixture({ surface: "lab" });
    const publication = fixture.publication({
      application: applicationCallbacks({ fetch: successfulCallbackResponse }),
    });
    vi.spyOn(fixture.storage, "read").mockImplementationOnce(() => {
      throw new Error("canonical_storage_unavailable");
    });

    const task = publication.scheduleCurrentTranscript();
    await expect(task).rejects.toThrow("canonical_storage_unavailable");
    expect(fixture.background.tasks).toEqual([task]);
    expect(fixture.alarmRecomputations).toBe(1);
    expect(fixture.storage.record).toEqual(fixture.record);
    await expect(publication.scheduleCurrentTranscript()).resolves.toMatchObject({
      status: "delivered",
      snapshot: { revision: 3 },
    });
    expect(fixture.alarmRecomputations).toBe(2);
  });

  it("delivers a newer canonical live revision while its predecessor is stalled", async () => {
    const fixture = await publicationFixture({ surface: "lab" });
    fixture.storage.record = {
      ...fixture.record,
      aggregate: liveFinalizationAggregate({
        runId: fixture.record.runId,
        transcriptCapture: fixture.record.aggregate.transcriptCapture,
      }),
    };
    const firstReply = deferred<Response>();
    const requests: Request[] = [];
    let firstRequest: Request | undefined;
    const publication = fixture.publication({
      application: applicationCallbacks({
        fetch: async (request) => {
          requests.push(request);
          const body = await readObject(request);
          if (isRecord(body.snapshot) && body.snapshot.revision === 0) {
            firstRequest = request;
            return firstReply.promise;
          }
          return successfulCallbackResponse(request);
        },
      }),
    });
    const first = publication.scheduleCurrentTranscript();
    const record = fixture.storage.record;
    if (record === null) throw new Error("Expected live record.");
    fixture.storage.record = {
      ...record,
      aggregate: {
        ...record.aggregate,
        transcriptRevision: 1,
        transcriptCapture: {
          sequence: 2,
          items: [
            {
              itemId: "item_1",
              firstSeenSequence: 1,
              role: "participant",
              text: "Hello again",
              finalSequence: 2,
            },
          ],
        },
      },
    };
    await expect(publication.scheduleCurrentTranscript()).resolves.toMatchObject({
      status: "delivered",
      snapshot: {
        revision: 1,
        transcript: { turns: [{ role: "participant", text: "Hello again" }] },
      },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    firstReply.resolve(await successfulCallbackResponse(requireRequest(firstRequest)));
    await expect(first).resolves.toMatchObject({ status: "delivered", snapshot: { revision: 0 } });
    expect(fixture.background.tasks).toHaveLength(2);
    expect(fixture.alarmRecomputations).toBe(2);
  });

  it("retains same-instance retry and original cutoff after a lost acknowledgement", async () => {
    const fixture = await publicationFixture({ surface: "lab" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const lostReply = deferred<Response>();
    const requests: Request[] = [];
    let now = 3_000;
    const publication = fixture.publication(
      {
        application: applicationCallbacks({
          fetch: async (request) => {
            requests.push(request);
            return requests.length === 1 ? lostReply.promise : successfulCallbackResponse(request);
          },
        }),
      },
      { now: () => now },
    );
    const first = publication.scheduleTerminal({ completion: fixture.completion, observedAt: now });
    if (!first.scheduled) throw new Error("Expected terminal owner.");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(
      publication.scheduleTerminal({ completion: fixture.completion, observedAt: now }),
    ).toEqual({
      scheduled: false,
      reason: "in_flight",
    });
    lostReply.reject(new Error("lost_acknowledgement"));
    await expect(fixture.background.tasks[0]).resolves.toMatchObject({
      status: "failed",
      disposition: "retryable",
    });
    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: "retrying",
      publicationCutoffAt: 32_000,
      retryAt: 5_000,
      attemptCount: 1,
    });
    now = 5_000;
    const retry = publication.scheduleTerminal({ completion: fixture.completion, observedAt: now });
    if (!retry.scheduled) throw new Error("Expected same-instance retry.");
    await expect(retry.task).resolves.toEqual({ status: "delivered", deliveredAt: 5_000 });
    expect(await requests[0]?.clone().text()).toBe(await requests[1]?.clone().text());
    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: "delivered",
      publicationCutoffAt: 32_000,
      attemptCount: 2,
    });
    expect(fixture.alarmRecomputations).toBe(2);
  });

  it("propagates wake-up rejection without erasing retry state or retaining single-flight", async () => {
    const fixture = await publicationFixture({ surface: "lab" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    let rejectWakeUp = true;
    const publication = fixture.publication(
      {
        application: applicationCallbacks({
          fetch: async () => new Response(null, { status: 503 }),
        }),
      },
      {
        requestAlarmRecomputation: async () => {
          if (rejectWakeUp) throw new Error("alarm_storage_rejected");
        },
      },
    );
    const first = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 3_000,
    });
    if (!first.scheduled) throw new Error("Expected terminal owner.");
    await expect(first.task).rejects.toThrow("alarm_storage_rejected");
    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: "retrying",
      publicationCutoffAt: 32_000,
      retryAt: 5_000,
      attemptCount: 1,
    });
    rejectWakeUp = false;
    const retry = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 5_000,
    });
    if (!retry.scheduled) throw new Error("Expected released owner.");
    await expect(retry.task).resolves.toMatchObject({
      status: "failed",
      error: "callback_http_503",
    });
    expect(publicationOf(fixture.storage.record?.aggregate)?.attemptCount).toBe(2);
  });

  it.each(["replaced", "expired"] as const)(
    "does not commit a late callback into %s publication work",
    async (change) => {
      const fixture = await publicationFixture({ surface: "lab" });
      fixture.storage.record = withTranscriptDelivered(fixture.record);
      const reply = deferred<Response>();
      const requests: Request[] = [];
      const publication = fixture.publication({
        application: applicationCallbacks({
          fetch: async (request) => {
            requests.push(request);
            return reply.promise;
          },
        }),
      });
      const scheduled = publication.scheduleTerminal({
        completion: fixture.completion,
        observedAt: 3_000,
      });
      if (!scheduled.scheduled) throw new Error("Expected terminal owner.");
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const record = fixture.storage.record;
      if (record === null) throw new Error("Expected record.");
      fixture.storage.record =
        change === "replaced"
          ? { ...record, runId: "another_run" }
          : withPublication(record, { ...pendingPublication, status: "expired" });
      const retained = fixture.storage.record;
      reply.resolve(await successfulCallbackResponse(requireRequest(requests[0])));
      await expect(scheduled.task).resolves.toEqual({
        status: "skipped",
        reason: "no_publication_record",
      });
      expect(fixture.storage.record).toEqual(retained);
      expect(fixture.storage.persisted).toEqual([]);
      expect(fixture.alarmRecomputations).toBe(1);
    },
  );

  it("retains the original publication failure and durable retry when Cause observation throws", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const recordEvent = fixture.events.recordEvent.bind(fixture.events);
    vi.spyOn(fixture.events, "recordEvent").mockImplementation((name, payload) => {
      if (name === "runtime.execution_failed") throw new Error("diagnostic_sink_rejected");
      recordEvent(name, payload);
    });
    const publication = fixture.publication(
      { application: applicationCallbacks({ fetch: successfulCallbackResponse }) },
      {
        crashInjector: (point) => {
          if (point === "before_request") throw new Error("original_publication_defect");
        },
      },
    );
    const scheduled = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2_000,
    });
    if (!scheduled.scheduled) throw new Error("Expected terminal publication to be scheduled.");

    await expect(scheduled.task).resolves.toEqual({
      status: "failed",
      error: "original_publication_defect",
      disposition: "retryable",
    });
    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: "retrying",
      publicationCutoffAt: 32_000,
      retryAt: 5_000,
      attemptCount: 1,
      lastError: "original_publication_defect",
    });
    expect(fixture.alarmRecomputations).toBe(1);
  });

  it("does not reopen delivery after the terminal state commits before a storage crash", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    fixture.storage.crashAfterPersist = (aggregate) => {
      if (publicationOf(aggregate)?.status === "delivered") {
        throw new Error("injected_crash:after_aggregate_write");
      }
    };
    const publication = fixture.publication({
      application: applicationCallbacks({ fetch: successfulCallbackResponse }),
    });

    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2_000,
    });
    if (!schedule.scheduled) throw new Error("Expected terminal publication to be scheduled.");

    await expect(schedule.task).resolves.toEqual({ status: "delivered", deliveredAt: 3_000 });
    expect(fixture.storage.persisted).toHaveLength(1);
    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: "delivered",
      attemptCount: 1,
      deliveredAt: 3_000,
    });
    expect(fixture.alarmRecomputations).toBe(1);
  });

  it("persists retryable failures with the established attempt count and wake-up", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const publication = fixture.publication({
      application: applicationCallbacks({
        fetch: async () => new Response("unavailable", { status: 503 }),
      }),
    });

    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2_000,
    });
    if (!schedule.scheduled) throw new Error("Expected terminal publication to be scheduled.");

    await expect(schedule.task).resolves.toEqual({
      status: "failed",
      error: "callback_http_503",
      disposition: "retryable",
    });
    expect(publicationOf(fixture.storage.record?.aggregate)).toEqual({
      status: "retrying",
      publicationCutoffAt: 32_000,
      transcriptDelivered: true,
      completionDelivered: false,
      retryAt: 5_000,
      attemptCount: 1,
      deliveredAt: null,
      lastError: "callback_http_503",
    });
    expect(fixture.alarmRecomputations).toBe(1);
  });

  it("starts no callback at the cutoff and retains frozen artifacts and diagnostics", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    const frozen = frozenResultOf(fixture.storage.record?.aggregate);
    if (fixture.storage.record === null) throw new Error("Expected publication record.");
    fixture.storage.record = withPublication(fixture.storage.record, {
      ...pendingPublication,
      status: "retrying",
      attemptCount: 3,
      retryAt: null,
      lastError: "callback_timed_out",
    });
    const fetch = vi.fn(successfulCallbackResponse);
    const publication = fixture.publication(
      { application: applicationCallbacks({ fetch }) },
      { now: () => 32_000 },
    );

    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 32_000,
    });
    if (!schedule.scheduled) throw new Error("Expected expiry work to be scheduled.");

    await expect(schedule.task).resolves.toEqual({ status: "expired", cutoffAt: 32_000 });
    expect(fetch).not.toHaveBeenCalled();
    expect(frozenResultOf(fixture.storage.record?.aggregate)).toEqual(frozen);
    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: "expired",
      publicationCutoffAt: 32_000,
      attemptCount: 3,
      retryAt: null,
      lastError: "callback_timed_out",
    });
    expect(
      fixture.events.diagnostics.find(({ type }) => type === "runtime.publication_expired"),
    ).toMatchObject({
      type: "runtime.publication_expired",
      payload: { cutoffAt: 32_000, attemptCount: 3 },
    });

    const restarted = fixture.publication(
      { application: applicationCallbacks({ fetch }) },
      { now: () => 60_000 },
    );
    const reconstructed = restarted.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 60_000,
    });
    if (!reconstructed.scheduled) throw new Error("Expected reconstructed expiry work.");
    await expect(reconstructed.task).resolves.toEqual({ status: "expired", cutoffAt: 32_000 });
    expect(fetch).not.toHaveBeenCalled();
    expect(frozenResultOf(fixture.storage.record?.aggregate)).toEqual(frozen);
  });

  it("uses only the remaining publication period for a callback transport", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(31_500);
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const fetch = vi.fn(async () => await new Promise<Response>(() => undefined));
    const publication = fixture.publication(
      { application: applicationCallbacks({ fetch }) },
      { now: () => Date.now() },
    );
    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 31_500,
    });
    if (!schedule.scheduled) throw new Error("Expected terminal publication to be scheduled.");

    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledOnce();
    expect(publicationOf(fixture.storage.record?.aggregate)?.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(schedule.task).resolves.toMatchObject({ status: "failed" });
    expect(publicationOf(fixture.storage.record?.aggregate)?.status).toBe("expired");
    expect(publicationOf(fixture.storage.record?.aggregate)?.attemptCount).toBe(1);
  });

  it("starts no Transcript transport when digest calculation reaches the cutoff", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    let now = 31_999;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      now = 32_000;
      return await digest(algorithm, data);
    });
    const fetch = vi.fn(successfulCallbackResponse);
    const publication = fixture.publication(
      { application: applicationCallbacks({ fetch }) },
      { now: () => now },
    );

    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 31_999,
    });
    if (!schedule.scheduled) throw new Error("Expected expiry work to be scheduled.");

    await expect(schedule.task).resolves.toEqual({ status: "expired", cutoffAt: 32_000 });
    expect(fetch).not.toHaveBeenCalled();
    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: "expired",
      publicationCutoffAt: 32_000,
      attemptCount: 0,
    });
  });

  it("does not start a callback when the cutoff passes after work selection", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const fetch = vi.fn(successfulCallbackResponse);
    const times = [31_999, 32_000, 32_000];
    const publication = fixture.publication(
      { application: applicationCallbacks({ fetch }) },
      { now: () => times.shift() ?? 32_000 },
    );
    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 31_999,
    });
    if (!schedule.scheduled) throw new Error("Expected expiry work to be scheduled.");

    await expect(schedule.task).resolves.toEqual({ status: "expired", cutoffAt: 32_000 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains a nonretryable acknowledgement received at the cutoff as blocked", async () => {
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const times = [31_500, 31_500, 31_500, 32_000];
    const publication = fixture.publication(
      {
        application: applicationCallbacks({
          fetch: async () =>
            Response.json(
              {
                version: 2,
                status: "snapshot_mismatch",
                requestedMatches: false,
                storedSnapshot: null,
              },
              { status: 409 },
            ),
        }),
      },
      { now: () => times.shift() ?? 32_000 },
    );
    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 31_500,
    });
    if (!schedule.scheduled) throw new Error("Expected terminal publication to be scheduled.");

    await expect(schedule.task).resolves.toMatchObject({
      status: "failed",
      disposition: "blocked_snapshot_conflict",
    });
    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: "blocked_snapshot_conflict",
      publicationCutoffAt: 32_000,
      retryAt: null,
      attemptCount: 1,
    });
  });

  it.each([
    {
      name: "nonretryable callback",
      response: () => new Response("bad request", { status: 400 }),
      disposition: "blocked_nonretryable_callback",
      error: "callback_http_400",
    },
    {
      name: "snapshot conflict",
      response: () =>
        Response.json({
          version: 2,
          status: "snapshot_mismatch",
          requestedMatches: false,
          storedSnapshot: null,
        }),
      disposition: "blocked_snapshot_conflict",
      error: "callback_snapshot_mismatch",
    },
  ] as const)("persists and diagnoses a blocked $name", async (example) => {
    const fixture = await publicationFixture({ surface: "test" });
    fixture.storage.record = withTranscriptDelivered(fixture.record);
    const publication = fixture.publication({
      application: applicationCallbacks({ fetch: async () => example.response() }),
    });

    const schedule = publication.scheduleTerminal({
      completion: fixture.completion,
      observedAt: 2_000,
    });
    if (!schedule.scheduled) throw new Error("Expected terminal publication to be scheduled.");
    await expect(schedule.task).resolves.toMatchObject({
      status: "failed",
      disposition: example.disposition,
      error: example.error,
    });

    expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
      status: example.disposition,
      retryAt: null,
      attemptCount: 1,
      lastError: example.error,
    });
    expect(fixture.events.diagnostics).toEqual([
      {
        type: "runtime.publication_blocked",
        payload: {
          disposition: example.disposition,
          error: example.error,
          source: "runtime_controller",
        },
        options: { observedAt: 3_000 },
      },
    ]);
  });

  it.each(["before_request", "after_response_before_receipt"] as const)(
    "recovers after an injected %s crash without changing frozen publication work",
    async (crashPoint) => {
      const fixture = await publicationFixture({ surface: "test" });
      fixture.storage.record = withTranscriptDelivered(fixture.record);
      const callbackBodies: string[] = [];
      const transport = {
        fetch: async (request: Request) => {
          callbackBodies.push(await request.clone().text());
          return successfulCallbackResponse(request);
        },
      };
      let armed = true;
      const crashing = fixture.publication(
        { application: applicationCallbacks(transport) },
        {
          crashInjector: (observed) => {
            if (armed && observed === crashPoint) throw new Error(`injected_crash:${crashPoint}`);
          },
        },
      );
      const first = crashing.scheduleTerminal({
        completion: fixture.completion,
        observedAt: 2_000,
      });
      if (!first.scheduled) throw new Error("Expected terminal publication to be scheduled.");
      await expect(first.task).resolves.toMatchObject({
        status: "failed",
        error: `injected_crash:${crashPoint}`,
      });
      expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
        status: "retrying",
        attemptCount: 1,
      });

      if (crashPoint === "before_request")
        expect(fixture.events.events).toContainEqual({
          name: "runtime.execution_failed",
          payload: {
            source: "runtime_controller",
            operation: "terminal_publication",
            failure: false,
            defect: true,
            interruption: false,
          },
        });

      armed = false;
      const restarted = fixture.publication({ application: applicationCallbacks(transport) });
      const second = restarted.scheduleTerminal({
        completion: fixture.completion,
        observedAt: 13_000,
      });
      if (!second.scheduled) throw new Error("Expected restarted publication to be scheduled.");
      await expect(second.task).resolves.toMatchObject({ status: "delivered" });
      expect(publicationOf(fixture.storage.record?.aggregate)).toMatchObject({
        status: "delivered",
        attemptCount: 2,
      });
      expect(new Set(callbackBodies).size).toBe(callbackBodies.length === 0 ? 0 : 1);
    },
  );
});

/** The fixture's frozen result: finalizedAt 2_000 plus the 30s publication period. */
const pendingPublication = {
  status: "pending",
  publicationCutoffAt: 32_000,
  transcriptDelivered: false,
  completionDelivered: false,
  retryAt: null,
  attemptCount: 0,
  deliveredAt: null,
  lastError: null,
} as const satisfies RuntimePublicationState;

function publicationOf(
  aggregate: InterviewFinalizationAggregate | undefined,
): RuntimePublicationState | undefined {
  return aggregate?.state.stage === "ended" ? aggregate.state.publication : undefined;
}

/** The frozen result without its publication progress. */
function frozenResultOf(aggregate: InterviewFinalizationAggregate | undefined) {
  if (aggregate?.state.stage !== "ended") return undefined;
  const { publication: _publication, ...result } = aggregate.state;
  return result;
}

/** The record once its frozen Transcript was delivered: a terminal attempt sends only the result. */
function withTranscriptDelivered(record: RuntimePublicationRecord): RuntimePublicationRecord {
  const state = record.aggregate.state;
  if (state.stage !== "ended") throw new Error("Expected a frozen publication record.");
  return withPublication(record, { ...state.publication, transcriptDelivered: true });
}

function withPublication(
  record: RuntimePublicationRecord,
  publication: RuntimePublicationState,
): RuntimePublicationRecord {
  const state = record.aggregate.state;
  if (state.stage !== "ended") throw new Error("Expected a frozen publication record.");
  return { ...record, aggregate: { ...record.aggregate, state: { ...state, publication } } };
}

async function publicationFixture({ surface }: Readonly<{ surface: "test" | "lab" }>) {
  const transcriptCapture = {
    sequence: 1,
    items: [
      {
        itemId: "item_1",
        firstSeenSequence: 1,
        role: "participant" as const,
        text: "Hello",
        finalSequence: 1,
      },
    ],
  };
  const snapshot = await createRuntimeTranscriptSnapshot(3, {
    turns: [{ role: "participant", text: "Hello" }],
  });
  const completion: RuntimeFinalizationCompletion = {
    runId: "run_publication_owner",
    outcome: "ended",
    endReason: "participant_stopped",
    source: "browser_request",
    endingStartedAt: 1_000,
    endedAt: 2_000,
    finalizationCutoffAt: 11_000,
    finalizedAt: 2_000,
    transcriptSnapshot: snapshot,
    warnings: [],
  };
  const aggregate: InterviewFinalizationAggregate = {
    ...liveFinalizationAggregate({
      runId: completion.runId,
      transcriptCapture,
    }),
    state: { stage: "ended", completion, publication: pendingPublication, effects: [] },
    transcriptRevision: snapshot.revision,
    transcriptDigest: snapshot.digest,
  };
  const record: RuntimePublicationRecord = {
    runId: completion.runId,
    deliveryTargetJson: JSON.stringify({
      integration: surface,
      context: { runId: completion.runId },
    }),
    diagnosticsContextJson: JSON.stringify({ surface }),
    aggregate,
  };
  const storage = new MemoryPublicationStorage(record);
  const events = new MemoryRuntimeEvents();
  const background = new MemoryBackgroundWork();
  let alarmRecomputations = 0;
  const publication = (
    transports: RuntimePublicationTransports,
    overrides: Readonly<{
      crashInjector?: ConstructorParameters<typeof RuntimePublication>[0]["crashInjector"];
      now?: () => number;
      requestAlarmRecomputation?: () => Promise<void>;
      execution?: Pick<ExecutionBridge, "run" | "runExit">;
    }> = {},
  ) =>
    new RuntimePublication({
      execution: overrides.execution ?? {
        run: (operation) => Effect.runPromise(operation),
        runExit: (operation) => Effect.runPromiseExit(operation),
      },
      storage,
      events,
      transports: {
        authorize: async () => {},
        deliver: async (_target, callback, request, signal) => {
          if (transports.override !== undefined) return transports.override.fetch(request);
          const application = transports.application;
          if (application === undefined) throw new Error("runtime_delivery_unconfigured");
          return deliverBoundedCallback((input) => application[callback](input), request, signal);
        },
      },
      backgroundWork: background,
      requestAlarmRecomputation: () =>
        Effect.promise(async () => {
          alarmRecomputations += 1;
          await overrides.requestAlarmRecomputation?.();
        }),
      now: overrides.now ?? (() => 3_000),
      crashInjector: overrides.crashInjector,
    });
  return {
    completion,
    snapshot,
    record,
    storage,
    events,
    background,
    publication,
    get alarmRecomputations() {
      return alarmRecomputations;
    },
  };
}

class MemoryPublicationStorage implements RuntimePublicationStorage {
  record: RuntimePublicationRecord | null;
  readonly persisted: InterviewFinalizationAggregate[] = [];
  crashAfterPersist: ((aggregate: InterviewFinalizationAggregate) => void) | null = null;

  constructor(record: RuntimePublicationRecord) {
    this.record = record;
  }

  read(): RuntimePublicationRecord | null {
    return this.record;
  }

  persist(aggregate: InterviewFinalizationAggregate): void {
    if (this.record === null) throw new Error("runtime_controller_not_started");
    this.persisted.push(aggregate);
    this.record = { ...this.record, aggregate };
    this.crashAfterPersist?.(aggregate);
  }
}

class MemoryBackgroundWork implements RuntimePublicationBackgroundWork {
  readonly tasks: Promise<unknown>[] = [];

  waitUntil(task: Promise<unknown>): void {
    this.tasks.push(task);
  }
}

class MemoryRuntimeEvents implements RuntimePublicationEvents {
  readonly events: Array<{ name: string; payload: RuntimeEventPayload }> = [];
  readonly diagnostics: Array<{
    type: string;
    payload: RuntimeEventPayload;
    options: RuntimeDiagnosticOptions;
  }> = [];

  recordEvent(name: string, payload: RuntimeEventPayload = {}): void {
    this.events.push({ name, payload });
  }

  recordUniqueDiagnostic(
    type: string,
    _predicate: (payload: Record<string, unknown>) => boolean,
    payload: RuntimeEventPayload = {},
    options: RuntimeDiagnosticOptions = {},
  ): RuntimeDiagnosticRecord | null {
    this.diagnostics.push({ type, payload, options });
    return null;
  }
}

async function successfulCallbackResponse(request: Request): Promise<Response> {
  const body = await readObject(request);
  const callbackSnapshot =
    body.type === "runtimeTranscriptUpdated" ? body.snapshot : body.completion;
  const storedSnapshot =
    body.type === "runtimeTranscriptUpdated"
      ? callbackSnapshot
      : isRecord(callbackSnapshot)
        ? callbackSnapshot.transcriptSnapshot
        : null;
  return Response.json({
    version: 2,
    status: body.type === "runtimeTranscriptUpdated" ? "stored" : "completed",
    requestedMatches: true,
    storedSnapshot,
  });
}

function failedToStartResult() {
  return {
    runId: "run_failed_start",
    outcome: "failed_to_start" as const,
    endedAt: 1_000,
    runtimeUsage: { completeness: "complete" as const, observations: [] },
  };
}

async function readObject(request: Request | undefined): Promise<Record<string, unknown>> {
  if (request === undefined) throw new Error("Expected a callback request.");
  const body: unknown = await request.clone().json();
  if (!isRecord(body)) throw new Error("Expected a callback object.");
  return body;
}

function requireString<Value>(value: Value): string {
  if (typeof value !== "string") throw new Error("Expected a string.");
  return value;
}

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRequest(request: Request | undefined): Request {
  if (request === undefined) throw new Error("Expected callback request.");
  return request;
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {
    throw new Error("uninitialized_deferred");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("uninitialized_deferred");
  };
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
