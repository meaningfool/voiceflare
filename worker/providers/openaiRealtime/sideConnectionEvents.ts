import { Clock, Deferred, Effect, Queue, type Scope } from "effect";
import type { ProviderSocketEvent, ProviderWebSocket } from "./openaiRealtimeDriver.ts";
import type { RuntimeEventPayload } from "../../runtime/runtimeEvents.ts";

/*
 * The Realtime session's native edge: what arrives on the side connection reaches Effect here,
 * as items for the events task and as the settlement of the node waits it answers. This module
 * is the session's only escape hatch (`effectEdges` in `scripts/check-effect-diagnostics.ts`).
 */

/**
 * A wait of node work that a receipt settles synchronously as it arrives, or that the node's
 * containment fails. Node work awaits it; the session's observation of each receipt settles it
 * in arrival order, before the receipt is handed to Runtime. It settles once.
 */
export class ReceiptWait<A, E> {
  readonly #deferred = Deferred.makeUnsafe<A, E>();
  /** Waits for its settlement. */
  get await(): Effect.Effect<A, E> {
    return Deferred.await(this.#deferred);
  }
  /** Whether it has settled. */
  get settled(): boolean {
    return Deferred.isDoneUnsafe(this.#deferred);
  }
  succeed(value: A): void {
    Deferred.doneUnsafe(this.#deferred, Effect.succeed(value));
  }
  fail(error: E): void {
    Deferred.doneUnsafe(this.#deferred, Effect.fail(error));
  }
}

/** One native event of the side connection, read on the Run's clock as it arrived. */
export type SideConnectionEvent =
  | Readonly<{ kind: "message"; event: ProviderSocketEvent; at: number }>
  | Readonly<{ kind: "close"; event: ProviderSocketEvent; at: number }>
  | Readonly<{ kind: "error"; at: number }>;

/**
 * The driver's diagnostics callback for a connection attempt: each event it reports
 * synchronously is read on the Run's clock as it happens.
 */
export function clockedDiagnostics(
  record: (event: string, data: RuntimeEventPayload, at: number) => void,
): Effect.Effect<(event: string, data?: RuntimeEventPayload) => void> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    return (event: string, data: RuntimeEventPayload = {}) =>
      record(event, data, clock.currentTimeMillisUnsafe());
  });
}

function isItemList<Item extends object>(value: Item | readonly Item[]): value is readonly Item[] {
  return Array.isArray(value);
}

/**
 * The native edge of a side connection: while the caller's Scope is open, each message, close
 * and error the socket delivers is turned into the caller's item by `arrive` at the moment it
 * arrives, and offered to `items` in arrival order. `arrive` runs synchronously in the socket's
 * callback, so what it records (such as the receipt order) is in place before the platform
 * runs anything else; an event it maps to null is not offered, and one it maps to several items
 * offers them in order. Closing the Scope removes the listeners, including those registered
 * before a registration failed, and a failed removal leaves the others to be removed.
 */
export function listenToSideConnection<Item extends object>(
  socket: ProviderWebSocket,
  items: Queue.Enqueue<Item>,
  arrive: (event: SideConnectionEvent) => Item | readonly Item[] | null,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const deliver = (event: SideConnectionEvent): void => {
      const arrived = arrive(event);
      if (arrived === null) return;
      for (const item of isItemList(arrived) ? arrived : [arrived]) Queue.offerUnsafe(items, item);
    };
    const listeners = [
      [
        "message",
        (event: ProviderSocketEvent) =>
          deliver({ kind: "message", event, at: clock.currentTimeMillisUnsafe() }),
      ],
      [
        "close",
        (event: ProviderSocketEvent) =>
          deliver({ kind: "close", event, at: clock.currentTimeMillisUnsafe() }),
      ],
      ["error", () => deliver({ kind: "error", at: clock.currentTimeMillisUnsafe() })],
    ] as const;
    // Register release before an adapter can partially attach and then fail.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [type, listener] of listeners) {
          try {
            socket.removeEventListener?.(type, listener);
          } catch {
            // Independent native release must leave the remaining finalizers runnable.
          }
        }
      }),
    );
    yield* Effect.sync(() => {
      for (const [type, listener] of listeners) socket.addEventListener(type, listener);
    });
  });
}
