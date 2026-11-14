import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { NativeWorkOwner } from "../../runtime/nativeWorkOwner.ts";
import { providerFailure, providerSuccess } from "../../runtime/providerOutcomes.ts";
import { acquireSideband, type ProviderOperationFailed } from "./sidebandAcquisition.ts";
import type { ProviderWebSocket, RealtimeDriver } from "./openaiRealtimeDriver.ts";
import type { ProviderOutcome } from "../../runtime/providerOutcomes.ts";
import {
  openAiDriverOver,
  realtimeTestDriver,
  type ScriptedRealtimeDriver,
} from "./testing/testDriver.ts";

describe("acquireSideband", () => {
  it("keeps late socket release after disposal without reopening the selected runtime", async () => {
    let resolveNative: (result: ProviderOutcome<ProviderWebSocket>) => void = () => {};
    const native = new Promise<ProviderOutcome<ProviderWebSocket>>((resolve) => {
      resolveNative = resolve;
    });
    let requested: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let signal: AbortSignal | undefined;
    const retained: Promise<void>[] = [];
    const execution = new NativeWorkOwner(() => {});
    const connect: ScriptedRealtimeDriver["connectSideband"] = (input) => {
      signal = input.signal;
      requested();
      return native;
    };
    const result = execution
      .run(
        failureOf(
          acquireSideband({
            callId: "rtc_disposed",
            apiKey: "controlled",
            emit: () => {},
            retainAcquisition: (task) => retained.push(task),
          }),
          connect,
        ),
      )
      .then(
        () => false,
        () => true,
      );
    await started;
    await execution.dispose();
    expect(await result).toBe(true);
    expect(signal?.aborted).toBe(true);
    const socket = {
      readyState: 1,
      accept: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
    };
    resolveNative(providerSuccess(socket));
    await Promise.all(retained);
    expect(socket.close.mock.calls).toEqual([[1000, "sideband_restore_no_longer_allowed"]]);
  });
  it.each([
    { mode: "last_rejection", deadlineAt: 1_100 },
    { mode: "pending_later_attempt", deadlineAt: 4_000 },
  ] as const)("preserves actual native cutoff evidence ($mode)", async ({ mode, deadlineAt }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts > 1) return await new Promise<Response>(() => {});
      return new Response("call_id_not_found", {
        status: 404,
        headers: { "x-request-id": "req_controlled_cutoff" },
      });
    };
    // The first attempt is refused; the next starts after its pause and never answers.
    const connect: ScriptedRealtimeDriver["connectSideband"] = (input) =>
      openAiDriverOver(fetchImpl).connectSideband(input);
    const execution = new NativeWorkOwner(() => {});
    try {
      const result = execution.run(
        failureOf(
          acquireSideband({
            callId: "rtc_controlled_cutoff",
            apiKey: "test",
            emit: () => {},
            retryDeadlineAt: deadlineAt,
          }),
          connect,
        ),
      );
      await vi.advanceTimersByTimeAsync(deadlineAt - 1_000);
      if (mode === "pending_later_attempt") expect(attempts).toBe(2);
      if (mode === "last_rejection")
        expect(await result).toEqual({
          kind: "provider_failure",
          stage: "session_setup",
          code: "sideband_call_id_not_found",
          providerStatus: 404,
          requestId: "req_controlled_cutoff",
          retryable: true,
        });
      else
        expect(await result).toEqual({
          kind: "provider_failure",
          stage: "session_setup",
          code: "sideband_connect_failed",
          retryable: false,
        });
      await execution.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["upgrade", "terminal_rejection"] as const)(
    "contains late acquisition at its original cutoff before the timer runs (%s)",
    async (nativeOutcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
      };
      let finish: (result: ProviderOutcome<ProviderWebSocket>) => void = () => {};
      const pending = new Promise<ProviderOutcome<ProviderWebSocket>>((resolve) => {
        finish = resolve;
      });
      const retained: Promise<void>[] = [];
      const inputs: Parameters<ScriptedRealtimeDriver["connectSideband"]>[0][] = [];
      const execution = new NativeWorkOwner(() => {});
      const connect: ScriptedRealtimeDriver["connectSideband"] = (input) => {
        inputs.push(input);
        return pending;
      };
      try {
        const result = execution.run(
          failureOf(
            acquireSideband({
              callId: "rtc_cutoff",
              apiKey: "test",
              emit: () => {},
              retryDeadlineAt: 1_010,
              retainAcquisition: (task) => retained.push(task),
            }),
            connect,
          ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(inputs).toHaveLength(1);
        vi.setSystemTime(1_020);
        const terminalRejection = providerFailure({
          stage: "session_setup",
          code: "sideband_call_id_not_found",
          providerStatus: 404,
          retryable: true,
        });
        finish(nativeOutcome === "upgrade" ? providerSuccess(socket) : terminalRejection);
        expect(await result).toEqual(
          nativeOutcome === "upgrade"
            ? {
                kind: "provider_failure",
                stage: "session_setup",
                code: "sideband_connect_failed",
                retryable: true,
              }
            : {
                kind: "provider_failure",
                stage: "session_setup",
                code: "sideband_call_id_not_found",
                providerStatus: 404,
                retryable: true,
              },
        );
        if (nativeOutcome === "upgrade")
          expect(socket.close.mock.calls).toEqual([[1000, "sideband_restore_no_longer_allowed"]]);
        else expect(socket.close).not.toHaveBeenCalled();
        await Promise.all(retained);
        await execution.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

/**
 * Expected acquisition failures are returned as their provider failure for assertions. The
 * acquisition runs on the kit's test driver, whose side connection is `connect`.
 */
function failureOf(
  acquisition: Effect.Effect<unknown, ProviderOperationFailed, RealtimeDriver>,
  connect: ScriptedRealtimeDriver["connectSideband"],
) {
  return acquisition.pipe(
    Effect.flip,
    Effect.map(({ failure }) => failure),
    Effect.orDie,
    Effect.provide(realtimeTestDriver({ connectSideband: connect })),
  );
}
