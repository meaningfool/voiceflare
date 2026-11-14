import { Clock, Data, Effect } from "effect";
import { callUntilDeadline } from "../shared/deadline.ts";
import { decodeRuntimeRequiredStopAcknowledgement } from "../shared/contracts/applicationStartup.ts";
import type { LabFetchBinding } from "./types.ts";
class RuntimeTransportFailure extends Data.TaggedError("RuntimeTransportFailure")<{
  cause: unknown;
}> {}
class RuntimeStopTimeout extends Data.TaggedError("RuntimeStopTimeout") {}
/** The persisted deadline owner schedules retries; this operation makes one bounded attempt. */
export function requestLabRequiredStop(
  runtime: LabFetchBinding,
  request: Request,
): Promise<ReturnType<typeof decodeRuntimeRequiredStopAcknowledgement> | null> {
  const operation: Effect.Effect<
    ReturnType<typeof decodeRuntimeRequiredStopAcknowledgement> | null,
    never
  > = Effect.gen(function* () {
    const deadlineAt = (yield* Clock.currentTimeMillis) + 4_000;
    const acknowledgement = yield* callUntilDeadline({
      deadlineAt,
      operation: async (signal) => {
        const response = await runtime.fetch(new Request(request, { signal }));
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        return decodeRuntimeRequiredStopAcknowledgement(await response.json());
      },
      onTransportFailure: (cause) => new RuntimeTransportFailure({ cause }),
      onTimeout: () => new RuntimeStopTimeout(),
    });
    return (yield* Clock.currentTimeMillis) >= deadlineAt ? null : acknowledgement;
  }).pipe(
    Effect.catchTags({
      RuntimeTransportFailure: () => Effect.succeed(null),
      RuntimeStopTimeout: () => Effect.succeed(null),
    }),
  );
  return Effect.runPromise(operation);
}
