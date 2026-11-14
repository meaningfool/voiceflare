import { Data, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { callUntilDeadline, remainingUntil, sleepUntil, untilDeadline } from "./deadline.ts";

class TransportFailure extends Data.TaggedError("TransportFailure")<{ readonly cause: unknown }> {}
class Timeout extends Data.TaggedError("Timeout") {}

function call<A>(deadlineAt: number, operation: (signal: AbortSignal) => Promise<A>) {
  return callUntilDeadline({
    deadlineAt,
    operation,
    onTransportFailure: (cause) => new TransportFailure({ cause }),
    onTimeout: () => new Timeout(),
  });
}

function run<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));
}

describe("remainingUntil", () => {
  it("leaves the time to the deadline in whole milliseconds, rounded up, and none once it is reached", async () => {
    const remaining = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        return [
          yield* remainingUntil(1_250),
          yield* remainingUntil(1_000.4),
          yield* remainingUntil(1_000),
          yield* remainingUntil(400),
        ];
      }),
    );
    expect(remaining).toEqual([250, 1, 0, 0]);
  });
});

describe("untilDeadline", () => {
  it("starts nothing at a passed deadline and takes the deadline's outcome at once", async () => {
    const started: string[] = [];
    const outcome = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        return yield* Effect.sync(() => started.push("operation")).pipe(
          Effect.as("completed"),
          untilDeadline(1_000, () => Effect.succeed("deadline")),
        );
      }),
    );
    expect({ outcome, started }).toEqual({ outcome: "deadline", started: [] });
  });

  it("interrupts the operation when the deadline is reached, not a millisecond earlier", async () => {
    const observed = await run(
      Effect.gen(function* () {
        const interrupted: number[] = [];
        const fiber = yield* Effect.forkChild(
          Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => interrupted.push(1))),
            untilDeadline(500, () => Effect.succeed("deadline")),
          ),
          { startImmediately: true },
        );
        yield* TestClock.adjust(499);
        const beforeDeadline = interrupted.length;
        yield* TestClock.adjust(1);
        const exit = yield* Fiber.await(fiber);
        return { beforeDeadline, afterDeadline: interrupted.length, exit };
      }),
    );
    expect(observed).toEqual({
      beforeDeadline: 0,
      afterDeadline: 1,
      exit: Exit.succeed("deadline"),
    });
  });

  it("keeps the operation's own outcome when it ends before the deadline", async () => {
    const outcome = await run(
      Effect.succeed("completed").pipe(untilDeadline(500, () => Effect.succeed("deadline"))),
    );
    expect(outcome).toBe("completed");
  });
});

describe("sleepUntil", () => {
  it("resumes at the deadline, and at once when it has passed", async () => {
    const observed = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(sleepUntil(300), { startImmediately: true });
        yield* TestClock.adjust(299);
        const beforeDeadline = fiber.pollUnsafe() !== undefined;
        yield* TestClock.adjust(1);
        yield* Fiber.join(fiber);
        const passed = yield* Effect.exit(sleepUntil(0));
        return { beforeDeadline, passed };
      }),
    );
    expect(observed).toEqual({ beforeDeadline: false, passed: Exit.void });
  });
});

describe("callUntilDeadline", () => {
  it("dispatches nothing once the deadline has passed", async () => {
    const dispatched: AbortSignal[] = [];
    const exit = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        return yield* Effect.exit(
          call(1_000, async (signal) => {
            dispatched.push(signal);
            return "sent";
          }),
        );
      }),
    );
    expect(exit).toEqual(Exit.fail(new Timeout()));
    expect(dispatched).toEqual([]);
  });

  it("aborts the native call and fails with the timeout at the deadline", async () => {
    const observed = await run(
      Effect.gen(function* () {
        const signals: AbortSignal[] = [];
        const fiber = yield* Effect.forkChild(
          call(500, (signal) => {
            signals.push(signal);
            return new Promise<never>(() => undefined);
          }),
          { startImmediately: true },
        );
        yield* TestClock.adjust(499);
        const beforeDeadline = signals.map((signal) => signal.aborted);
        yield* TestClock.adjust(1);
        const exit = yield* Fiber.await(fiber);
        return { beforeDeadline, afterDeadline: signals.map((signal) => signal.aborted), exit };
      }),
    );
    expect(observed).toEqual({
      beforeDeadline: [false],
      afterDeadline: [true],
      exit: Exit.fail(new Timeout()),
    });
  });

  it("aborts the native call when its caller is interrupted", async () => {
    const aborted = await run(
      Effect.gen(function* () {
        const signals: AbortSignal[] = [];
        const fiber = yield* Effect.forkChild(
          call(500, (signal) => {
            signals.push(signal);
            return new Promise<never>(() => undefined);
          }),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(fiber);
        return signals.map((signal) => signal.aborted);
      }),
    );
    expect(aborted).toEqual([true]);
  });

  it("leaves a completed call's signal open and maps a rejection to the transport failure", async () => {
    const cause = new Error("connection_reset");
    const observed = await run(
      Effect.gen(function* () {
        const signals: AbortSignal[] = [];
        const success = yield* call(500, async (signal) => {
          signals.push(signal);
          return "stream";
        });
        const failure = yield* Effect.exit(call(500, () => Promise.reject(cause)));
        return { success, open: signals.map((signal) => !signal.aborted), failure };
      }),
    );
    expect(observed).toEqual({
      success: "stream",
      open: [true],
      failure: Exit.fail(new TransportFailure({ cause })),
    });
  });
});
