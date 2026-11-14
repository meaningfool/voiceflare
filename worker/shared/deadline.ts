import { Clock, Effect } from "effect";

/**
 * Deadlines shared by Runtime, both execution kits, the pairs and the applications. A
 * deadline is an absolute time in epoch milliseconds, read against Effect's Clock, and one rule
 * turns it into time left:
 *
 * - The time left is the deadline minus the Clock's current time, rounded up to a whole
 *   millisecond, and never less than zero.
 * - A deadline with no time left has passed. A passed deadline starts nothing: the bounded
 *   operation is not started and the deadline's outcome follows at once. There is no minimum
 *   grace and no extension.
 *
 * Deadlines are never renewed here: every helper reads the same absolute deadline it was given.
 */

/** The time left before `deadlineAt` at `now`, by the rule above; zero once it has passed. */
export function millisecondsUntil(deadlineAt: number, now: number): number {
  return Math.max(0, Math.ceil(deadlineAt - now));
}

/** The time left before `deadlineAt` on the Clock; zero once it has passed. */
export function remainingUntil(deadlineAt: number): Effect.Effect<number> {
  return Effect.map(Clock.currentTimeMillis, (now) => millisecondsUntil(deadlineAt, now));
}

/**
 * Bounds an operation by `deadlineAt`. At a passed deadline the operation is not started and
 * `onDeadline` runs at once; otherwise the operation is interrupted when the deadline is reached
 * and `onDeadline` decides the outcome.
 */
export function untilDeadline<B, E2, R2>(
  deadlineAt: number,
  onDeadline: () => Effect.Effect<B, E2, R2>,
): <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A | B, E | E2, R | R2> {
  return (operation) =>
    Effect.flatMap(remainingUntil(deadlineAt), (remainingMs) =>
      remainingMs === 0
        ? onDeadline()
        : Effect.timeoutOrElse(operation, { duration: remainingMs, orElse: onDeadline }),
    );
}

/** Waits until `deadlineAt`. A passed deadline waits no time: it yields once and returns. */
export function sleepUntil(deadlineAt: number): Effect.Effect<void> {
  return Effect.flatMap(remainingUntil(deadlineAt), (remainingMs) => Effect.sleep(remainingMs));
}

/**
 * Runs one native call until an absolute deadline, for owners whose native work is a promise.
 *
 * - Nothing is dispatched once `deadlineAt` has passed; the call fails with `onTimeout()`.
 * - A rejected operation fails with `onTransportFailure(cause)`.
 * - The signal is aborted when the deadline is reached or the caller is interrupted. A completed
 *   call leaves it untouched, so a returned stream stays readable; buffer finite replies inside
 *   `operation` to keep them under the deadline.
 * - Workerd RPC does not carry an explicit signal to the receiver. The deadline then bounds only
 *   the local wait; it does not cancel or roll back remote work.
 */
export function callUntilDeadline<A, TransportFailure, Timeout>(
  input: Readonly<{
    deadlineAt: number;
    operation: (signal: AbortSignal) => Promise<A>;
    onTransportFailure: (cause: unknown) => TransportFailure;
    onTimeout: () => Timeout;
  }>,
): Effect.Effect<A, TransportFailure | Timeout> {
  return Effect.tryPromise({
    try: (signal) => input.operation(signal),
    catch: input.onTransportFailure,
  }).pipe(untilDeadline(input.deadlineAt, () => Effect.fail(input.onTimeout())));
}
