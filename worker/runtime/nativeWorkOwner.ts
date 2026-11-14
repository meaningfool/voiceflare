import { Cause, Context, Data, Effect, Exit, Fiber, Scope } from "effect";
import type { ProviderSessionBackgroundWork } from "./nativeContracts.ts";
import type { ExecutionBridge } from "./runtimeHostAssembly.ts";

class NativeReleaseDeadline extends Data.TaggedError("NativeReleaseDeadline")<{
  timeoutMs: number;
}> {}
const releaseObservationMs = 1_000;

/**
 * The owner of one Run's native work, whatever its execution. It runs on the services of the
 * runtime that created it. Every native resource it starts belongs to its one Scope, and
 * closing the owner closes that Scope. Runtime creates one for every Run whose selection the
 * registry holds.
 */
export class NativeWorkOwner {
  // Parallel release: one held finalizer cannot delay interrupting the other resources.
  readonly #scope = Scope.makeUnsafe("parallel");
  readonly #services: Context.Context<never>;
  readonly #failure: (cause: Cause.Cause<unknown>) => void;
  readonly #retainRelease: ((task: Promise<unknown>) => void) | undefined;
  #release: Fiber.Fiber<void> | null = null;
  #disposal: Promise<void> | null = null;
  constructor(
    failure: (cause: Cause.Cause<unknown>) => void,
    retainRelease?: (task: Promise<unknown>) => void,
    services: Context.Context<never> = Context.empty(),
  ) {
    this.#failure = failure;
    this.#retainRelease = retainRelease;
    this.#services = services;
  }

  /**
   * Starts `operation` now as a fiber in this owner's Scope and reports its failed Exit.
   * A closed owner starts nothing: the returned fiber is already interrupted.
   */
  fork<A>(operation: Effect.Effect<A, never>): Effect.Effect<Fiber.Fiber<A, never>> {
    return Effect.suspend(() => {
      if (this.#scope.state._tag === "Closed")
        return Effect.forkDetach(Effect.interrupt, { startImmediately: true });
      // Report each exit in its own fiber, before the Scope can release its resources.
      const observed = operation.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Effect.sync(() => this.#failure(exit.cause)) : Effect.void,
        ),
      );
      return Effect.forkIn(observed, this.#scope, { startImmediately: true });
    });
  }
  /** Starts a long-running native operation that this owner supervises until it closes. */
  supervise<A>(operation: Effect.Effect<A, never>): Fiber.Fiber<A, never> {
    return Effect.runSyncWith(this.#services)(this.fork(operation));
  }
  async run<A>(operation: Effect.Effect<A, never>): Promise<A> {
    const exit = await this.runExit(operation);
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  }
  runExit<A>(operation: Effect.Effect<A, never>): Promise<Exit.Exit<A, never>> {
    return Effect.runPromiseWith(this.#services)(Effect.flatMap(this.fork(operation), Fiber.await));
  }

  /**
   * Closes this owner's Scope: its supervised fibers are interrupted and their
   * finalizers, including late native release, run. Observation is bounded; a release
   * that outlives the bound stays retained and grants no further media permission.
   */
  readonly close: Effect.Effect<void> = this.#closeScope();

  #closeScope(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (self.#release === null) {
        const release = yield* Effect.forkDetach(
          Scope.close(self.#scope, Exit.void).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Effect.sync(() => self.#failure(exit.cause)) : Effect.void,
            ),
          ),
          { startImmediately: true },
        );
        self.#release = release;
        self.#retainRelease?.(
          new Promise<void>((resolve, reject) => {
            release.addObserver((exit) =>
              Exit.isSuccess(exit) ? resolve() : reject(Cause.squash(exit.cause)),
            );
          }),
        );
      }
      yield* Fiber.join(self.#release).pipe(
        Effect.timeoutOrElse({
          duration: releaseObservationMs,
          orElse: () =>
            Effect.sync(() =>
              self.#failure(
                Cause.fail(new NativeReleaseDeadline({ timeoutMs: releaseObservationMs })),
              ),
            ),
        }),
      );
    });
  }

  dispose(): Promise<void> {
    this.#disposal ??= Effect.runPromiseWith(this.#services)(this.close);
    return this.#disposal;
  }
}

/**
 * Settles when a supervised fiber has ended, for the platform's lifetime retention only.
 * Its owner observes the Exit; this never rejects.
 */
function settled(fiber: Fiber.Fiber<unknown, unknown>): Promise<void> {
  return new Promise((resolve) => {
    fiber.addObserver(() => resolve());
  });
}

/**
 * Starts native work under the Run's native work owner and keeps the platform holding the Run
 * until that work ends: the one way a session keeps its supervised work alive.
 */
export function superviseRetained<A>(
  execution: Pick<ExecutionBridge, "supervise">,
  backgroundWork: ProviderSessionBackgroundWork,
  operation: Effect.Effect<A, never>,
): Fiber.Fiber<A, never> {
  const fiber = execution.supervise(operation);
  backgroundWork.waitUntil(settled(fiber));
  return fiber;
}
