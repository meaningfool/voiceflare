import { Cause, Context, Effect, Exit, Fiber, Option, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { NativeWorkOwner, superviseRetained } from "./nativeWorkOwner.ts";
import {
  acquireSideband,
  type ProviderOperationFailed,
} from "../providers/openaiRealtime/sidebandAcquisition.ts";
import type { ProviderWebSocket } from "../providers/openaiRealtime/openaiRealtimeDriver.ts";
import {
  realtimeTestDriver,
  type ScriptedRealtimeDriver,
} from "../providers/openaiRealtime/testing/testDriver.ts";
import { providerSuccess, type ProviderOutcome } from "./providerOutcomes.ts";
import {
  conversationCatalog,
  createRuntimeHostAssembly,
  runtimeHostAssembly,
} from "../runtimeHostComposition.ts";
import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";

it.each(conversationCatalog({}).selections.map(({ selection }) => selection))(
  "bounds native acquisition through the selected host assembly for $conversation.id on $execution.id",
  async (selection) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let resolveNative = (_result: ProviderOutcome<ProviderWebSocket>) => {};
    const pending = new Promise<ProviderOutcome<ProviderWebSocket>>((resolve) => {
      resolveNative = resolve;
    });
    let signal: AbortSignal | undefined;
    const retained: Promise<void>[] = [];
    const connectSideband = vi.fn<ScriptedRealtimeDriver["connectSideband"]>((input) => {
      signal = input.signal;
      return pending;
    });
    let selected: typeof selection | null = null;
    const host = Scope.makeUnsafe();
    const execution = acquireExecution(host, {
      failure: () => {},
      selection: () => selected,
    });
    selected = selection;
    try {
      const acquisition = execution.supervise(
        failureOf(
          acquireSideband({
            callId: "rtc_assembled_cutoff",
            apiKey: "controlled",
            emit: () => {},
            retryDeadlineAt: 1100,
            retainAcquisition: (task) => retained.push(task),
          }).pipe(Effect.provide(realtimeTestDriver({ connectSideband }))),
        ),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(await Effect.runPromise(Fiber.join(acquisition))).toEqual({
        kind: "provider_failure",
        stage: "session_setup",
        code: "sideband_connect_failed",
        retryable: true,
      });
      expect(signal?.aborted).toBe(true);
      const close = vi.fn();
      resolveNative(
        providerSuccess({
          readyState: 1,
          accept() {},
          send() {},
          close,
          addEventListener() {},
        }),
      );
      await Promise.all(retained);
      expect(close.mock.calls).toEqual([[1000, "sideband_restore_no_longer_allowed"]]);
      await Effect.runPromise(Scope.close(host, Exit.void));
      const refused = await Effect.runPromise(
        Fiber.await(
          execution.supervise(
            failureOf(
              acquireSideband({
                callId: "rtc_retired",
                apiKey: "controlled",
                emit: () => {},
                retryDeadlineAt: 1200,
              }).pipe(Effect.provide(realtimeTestDriver({ connectSideband }))),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(refused) && Cause.hasInterruptsOnly(refused.cause)).toBe(true);
      expect(connectSideband).toHaveBeenCalledOnce();
    } finally {
      await Effect.runPromise(Scope.close(host, Exit.void));
      vi.useRealTimers();
    }
  },
);
// A failed start's cleanup, before any Conversation is admitted, reaches the execution that
// started the call: the one that accepts the start's connection profile.
it.each([
  [
    "realtime-v1",
    { status: "close_unconfirmed" },
    [[{ apiKey: "test", callId: "rtc_cleanup", timeoutMs: 2_000 }]],
  ],
  ["cascade-media-v1", { status: "closed" }, []],
  [
    "unregistered-v1",
    {
      status: "close_unconfirmed",
      failure: { status: "failed", timedOut: false, code: "connection_profile_unavailable" },
    },
    [],
  ],
])(
  "releases an exact call for a Run without an accepted selection through the execution of profile %s",
  async (profile, released, hangUps) => {
    const hangUp = vi.fn<ScriptedRealtimeDriver["hangUp"]>(async () =>
      providerSuccess({ status: 204, upstreamRequestId: "req_cleanup" }),
    );
    const unexpected = () => {
      throw new Error("unexpected_session_capability");
    };
    const host = Scope.makeUnsafe();
    const execution = acquireExecution(host, {
      failure: () => {},
      selection: () => null,
    });
    const session = createRuntimeHostAssembly({
      realtimeDriver: realtimeTestDriver({ hangUp }),
    }).createSession(
      {
        credentials: { OPENAI_API_KEY: "test" },
        connectionProfile: () => profile,
        hangupTimeoutSetting: "5000",
        execution,
        storage: {
          read: unexpected,
          claimOpening: unexpected,
          markOpeningSent: unexpected,
          recordSessionIdentity: unexpected,
          recordSessionReply: unexpected,
          setGeneration: unexpected,
          markStarted: unexpected,
          markClosed: unexpected,
          scheduleWake: unexpected,
          hasEventIdentity: unexpected,
        },
        events: {
          notifyControl: unexpected,
          recordStartup: unexpected,
          recordLiveDegradation: unexpected,
          executionDiagnostics: unexpected,
        },
        backgroundWork: { waitUntil: unexpected },
        sink: unexpected,
      },
      () => null,
    );
    expect(await Effect.runPromise(session.release("rtc_cleanup", 2_000))).toEqual(released);
    expect(hangUp.mock.calls).toEqual(hangUps);
    // Cleanup admits no Conversation: work that needs a selected pair is still refused.
    expect(() => session.ensureConnected("rtc_cleanup")).toThrow(
      "native_session_selection_missing",
    );
    await Effect.runPromise(Scope.close(host, Exit.void));
  },
);
it("reports only defects: work that stops by interruption, as at a step change or the release of a retired Run, did not fail", async () => {
  let retired = false;
  const failures: Cause.Cause<unknown>[] = [];
  const host = Scope.makeUnsafe();
  const execution = acquireExecution(host, {
    failure: (cause) => failures.push(cause),
    selection: () => originalRealtimeSelection,
    retired: () => retired,
  });
  try {
    const defect = new Error("controlled_native_defect");
    execution.supervise(Effect.die(defect));
    // A step that ends its work by interruption, while the Run is live.
    execution.supervise(Effect.interrupt);
    let released = 0;
    const native = execution.supervise(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (released += 1)))),
    );
    let leave: () => void = () => {};
    const outer = Effect.runPromise(
      execution.enter(Effect.promise(() => new Promise<void>((resolve) => (leave = resolve)))),
    );
    await Effect.runPromise(execution.enter(Effect.sync(() => (retired = true))));
    // The outer entry still holds the owner; the retired Run starts no new native work.
    expect(released).toBe(0);
    let started = false;
    execution.supervise(Effect.sync(() => (started = true)));
    leave();
    await outer;
    const exit = await Effect.runPromise(Fiber.await(native));
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(released).toBe(1);
    expect(started).toBe(false);
    // Releasing the retired owner is not an execution failure; the earlier defect is.
    expect(failures.map((cause) => Cause.squash(cause))).toEqual([defect]);
  } finally {
    await Effect.runPromise(Scope.close(host, Exit.void));
  }
});
describe("NativeWorkOwner host boundary", () => {
  it("runs on its creator's services and starts nothing once closed", async () => {
    const execution = new NativeWorkOwner(
      () => {},
      undefined,
      Context.make(HostService, { host: "runtime" }),
    );
    try {
      const host = await execution.run(Effect.serviceOption(HostService));
      expect(Option.getOrUndefined(host)).toEqual({ host: "runtime" });
      const disposal = execution.dispose();
      expect(execution.dispose()).toBe(disposal);
      await disposal;
      let lateCalls = 0;
      const retired = await execution.runExit(
        Effect.sync(() => {
          lateCalls += 1;
        }),
      );
      expect(Exit.isFailure(retired) && Cause.hasInterrupts(retired.cause)).toBe(true);
      expect(lateCalls).toBe(0);
    } finally {
      await execution.dispose();
    }
  });
  it("interrupts supervised active work and observes native release before disposal completes", async () => {
    const observed: Cause.Cause<unknown>[] = [];
    const execution = new NativeWorkOwner((cause) => observed.push(cause));
    let acquired: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let releases = 0;
    const active = execution.runExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              releases += 1;
            }),
          );
          yield* Effect.sync(acquired);
          yield* Effect.never;
        }),
      ),
    );
    await ready;
    await execution.dispose();
    const exit = await active;
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(releases).toBe(1);
    expect(observed.some((cause) => Cause.hasInterrupts(cause))).toBe(true);
  });
  it("bounds release observation while retaining an uninterruptible native finalizer", async () => {
    vi.useFakeTimers();
    const observed: Cause.Cause<unknown>[] = [];
    const retained: Promise<unknown>[] = [];
    const execution = new NativeWorkOwner(
      (cause) => observed.push(cause),
      (task) => retained.push(task),
    );
    let acquired: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let release: () => void = () => {};
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let released = false;
    const active = execution.runExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await releaseGate;
              released = true;
            }),
          );
          yield* Effect.sync(acquired);
          yield* Effect.never;
        }),
      ),
    );
    try {
      await ready;
      const disposal = execution.dispose();
      await vi.advanceTimersByTimeAsync(1_000);
      await disposal;
      expect(released).toBe(false);
      expect(retained).toHaveLength(1);
      expect(observed.map((cause) => Cause.squash(cause))).toContainEqual(
        expect.objectContaining({ _tag: "NativeReleaseDeadline", timeoutMs: 1_000 }),
      );
      release();
      await Promise.all(retained);
      const exit = await active;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(released).toBe(true);
    } finally {
      release();
      await execution.dispose();
      vi.useRealTimers();
    }
  });
  it("retains defects and interruption as distinct exits", async () => {
    const observed: Cause.Cause<unknown>[] = [];
    const execution = new NativeWorkOwner((cause) => observed.push(cause));
    const defect = new Error("controlled_defect");
    const exits = await Promise.all([
      execution.runExit(Effect.die(defect)),
      execution.runExit(Effect.interrupt),
    ]);
    expect(
      exits.map((exit) =>
        Exit.isFailure(exit)
          ? {
              failed: Cause.hasFails(exit.cause),
              defect: Cause.hasDies(exit.cause),
              interrupted: Cause.hasInterrupts(exit.cause),
            }
          : null,
      ),
    ).toEqual([
      { failed: false, defect: true, interrupted: false },
      { failed: false, defect: false, interrupted: true },
    ]);
    expect(Exit.isFailure(exits[0]) ? Cause.squash(exits[0].cause) : null).toBe(defect);
    expect(observed).toEqual(exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : [])));
    await execution.dispose();
  });
  it("holds the Run until supervised work ends, whatever its exit", async () => {
    const execution = new NativeWorkOwner(() => {});
    const held: Promise<unknown>[] = [];
    let finish: () => void = () => {};
    const work = superviseRetained(
      execution,
      { waitUntil: (task) => held.push(task) },
      Effect.promise(() => new Promise<void>((resolve) => (finish = resolve))).pipe(
        Effect.andThen(Effect.die(new Error("controlled_native_defect"))),
      ),
    );
    let released = false;
    const holding = Promise.all(held).then(() => (released = true));
    // Every pending callback runs before this timer: only the work's end releases the Run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toHaveLength(1);
    expect(released).toBe(false);
    finish();
    await holding;
    expect(released).toBe(true);
    const exit = await Effect.runPromise(Fiber.await(work));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    await execution.dispose();
  });
});

class HostService extends Context.Service<HostService, { host: string }>()("test/HostService") {}

/** Acquires the host bridge in `host`, as the Runtime Layer does in its own Scope. */
function acquireExecution(
  host: Scope.Scope,
  input: Parameters<typeof runtimeHostAssembly.createExecution>[0],
) {
  return Effect.runSync(Scope.provide(host)(runtimeHostAssembly.createExecution(input)));
}

/** Expected acquisition failures are returned as their provider failure for assertions. */
function failureOf(acquisition: Effect.Effect<unknown, ProviderOperationFailed>) {
  return acquisition.pipe(
    Effect.flip,
    Effect.map(({ failure }) => failure),
    Effect.orDie,
  );
}
