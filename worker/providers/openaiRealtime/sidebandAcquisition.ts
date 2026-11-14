import { Data, Effect } from "effect";
import { remainingUntil, untilDeadline } from "../../shared/deadline.ts";
import {
  RealtimeDriver,
  type ProviderWebSocket,
  type RealtimeSidebandRequest,
} from "./openaiRealtimeDriver.ts";
import type { ProviderFailureOutcome } from "../../runtime/providerOutcomes.ts";

/** An expected provider failure, carried in the error channel to its owner's outcome mapping. */
export class ProviderOperationFailed extends Data.TaggedError("ProviderOperationFailed")<{
  readonly failure: ProviderFailureOutcome;
}> {}

const expiredSidebandSetup: ProviderFailureOutcome = {
  kind: "provider_failure",
  stage: "session_setup",
  code: "sideband_connect_failed",
  retryable: true,
};

/**
 * Acquires one sideband connection through the Realtime driver before its original absolute
 * deadline. Interrupting the acquisition interrupts the driver's attempt, which releases a
 * socket that arrives after that. A socket the driver returns at or after the deadline is
 * released here and never returned. Expected provider failures fail with
 * `ProviderOperationFailed`.
 */
export function acquireSideband(
  input: RealtimeSidebandRequest,
): Effect.Effect<ProviderWebSocket, ProviderOperationFailed, RealtimeDriver> {
  return Effect.gen(function* () {
    const driver = yield* RealtimeDriver;
    const deadlineAt = input.retryDeadlineAt;
    let lastFailure: ProviderFailureOutcome | undefined;
    const expired = () =>
      new ProviderOperationFailed({ failure: lastFailure ?? expiredSidebandSetup });
    const acquisition = driver.connectSideband({
      ...input,
      observeAttempt(observation) {
        lastFailure = structuredClone(
          observation.kind === "started" ? observation.deadlineFailure : observation.failure,
        );
        input.observeAttempt?.(structuredClone(observation));
      },
    });
    const result = yield* deadlineAt === undefined
      ? acquisition
      : acquisition.pipe(untilDeadline(deadlineAt, () => Effect.fail(expired())));
    if (!result.ok) return yield* new ProviderOperationFailed({ failure: result.failure });
    if (deadlineAt !== undefined && (yield* remainingUntil(deadlineAt)) === 0) {
      releaseLateSocket(result.value);
      return yield* expired();
    }
    return result.value;
  });
}

function releaseLateSocket(socket: ProviderWebSocket): void {
  try {
    socket.close(1000, "sideband_restore_no_longer_allowed");
  } catch {
    /* Native release must not manufacture provider evidence. */
  }
}
