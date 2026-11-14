import { Clock, Data, Effect } from "effect";
import { z } from "zod";
import { boundary } from "../tools/boundary-contracts/boundary-contracts.mjs";
import type { RuntimeDeliveryTarget } from "./shared/contracts/runtimeDelivery.ts";
import type { RuntimeDelivery } from "./runtime/runtimeDelivery.ts";
import type { RuntimeEnvironmentCapabilities } from "./runtime/types.ts";
import { callUntilDeadline, remainingUntil } from "./shared/deadline.ts";
import {
  applicationCallbackUrl,
  deliverBoundedCallback,
  type ApplicationCallbacks,
} from "./runtime/applicationCallbacks.ts";

class AdmissionRefused extends Data.TaggedError("AdmissionRefused")<{ readonly cause: unknown }> {}
class AdmissionTimedOut extends Data.TaggedError("AdmissionTimedOut") {}

/** Every application's delivery context is the Run it allocated. */
const deliveryContext = boundary({
  schema: z
    .unknown()
    .superRefine((value, context) => {
      if (
        value !== null &&
        typeof value === "object" &&
        "runId" in value &&
        !Object.hasOwn(value, "runId")
      )
        context.addIssue({ code: "custom", path: ["runId"], message: "must be an own property" });
    })
    .pipe(z.strictObject({ runId: z.string().min(1) })),
  convert: (value) => value,
});
const admissionReceipt = boundary({
  schema: z.strictObject({ runId: z.string().min(1), authorized: z.literal(true) }),
  convert: (value) => value,
});
const ownIdentity = z.unknown().superRefine((value, context) => {
  if (value === null || typeof value !== "object") return;
  for (const key of ["runId", "completion"])
    if (key in value && !Object.hasOwn(value, key))
      context.addIssue({ code: "custom", path: [key], message: "must be an own property" });
  if (
    "completion" in value &&
    value.completion !== null &&
    typeof value.completion === "object" &&
    "runId" in value.completion &&
    !Object.hasOwn(value.completion, "runId")
  )
    context.addIssue({
      code: "custom",
      path: ["completion", "runId"],
      message: "must be an own property",
    });
});
export const decodeDeliveryIdentity = boundary({
  schema: ownIdentity.pipe(
    z.union([
      z.object({ runId: z.string().min(1) }),
      z.object({ completion: z.object({ runId: z.string().min(1) }) }),
    ]),
  ),
  convert: (value) => ("runId" in value ? value.runId : value.completion.runId),
});

/**
 * The Runtime Worker's configuration names each application it delivers to with a service binding
 * `<APPLICATION>_CALLBACK_WORKER`, and a Start names that application in lower case as its
 * delivery target's integration.
 */
type ApplicationBindingName = Extract<keyof RuntimeEnv, `${string}_CALLBACK_WORKER`>;
const applicationBindingName = /^([A-Z][A-Z0-9]*)_CALLBACK_WORKER$/;

function isApplicationBindingName(name: string): name is ApplicationBindingName {
  return applicationBindingName.test(name);
}

/** The applications the configuration binds, by the integration a Start names. */
function configuredApplications(
  env: RuntimeEnvironmentCapabilities,
): ReadonlyMap<string, ApplicationCallbacks> {
  const applications = new Map<string, ApplicationCallbacks>();
  for (const name of Object.keys(env)) {
    if (!isApplicationBindingName(name)) continue;
    const callbacks = env[name];
    if (callbacks !== undefined)
      applications.set(name.slice(0, -"_CALLBACK_WORKER".length).toLowerCase(), callbacks);
  }
  return applications;
}

export function createRuntimeHostDelivery(env: RuntimeEnvironmentCapabilities): RuntimeDelivery {
  const applications = configuredApplications(env);
  function select(target: RuntimeDeliveryTarget) {
    const callbacks = applications.get(target.integration);
    if (callbacks === undefined) throw new Error("runtime_delivery_unconfigured");
    return { runId: deliveryContext(target.context).runId, callbacks };
  }
  const delivery: RuntimeDelivery = {
    async authorize(target, runId, expiresAt) {
      const selected = select(target);
      if (selected.runId !== runId) throw new Error("runtime_delivery_run_mismatch");
      const controller = new AbortController();
      const admit = async () => {
        const url = new URL("https://application-delivery.internal/authorize");
        url.searchParams.set("runId", runId);
        const response = await deliverBoundedCallback(
          (request) => selected.callbacks.authorizeDelivery(request),
          new Request(url, { signal: controller.signal }),
          controller.signal,
        );
        if (!response.ok) throw new Error("runtime_delivery_unauthorized");
        const receipt = admissionReceipt(await response.json());
        if (receipt.runId !== runId) throw new Error("runtime_delivery_run_mismatch");
      };
      try {
        const refusal = await Effect.runPromise(
          Effect.gen(function* () {
            // One admission attempt, bounded by the Run's startup expiry and its own bound.
            const deadlineAt = Math.min(expiresAt, (yield* Clock.currentTimeMillis) + 4_000);
            if ((yield* remainingUntil(deadlineAt)) === 0)
              return { cause: new Error("runtime_delivery_admission_expired") };
            yield* callUntilDeadline({
              deadlineAt,
              operation: (signal) => {
                signal.addEventListener("abort", () => controller.abort(), { once: true });
                return admit();
              },
              onTransportFailure: (cause) => new AdmissionRefused({ cause }),
              onTimeout: () => new AdmissionTimedOut(),
            });
            return null;
          }).pipe(
            Effect.catchTags({
              AdmissionRefused: ({ cause }) => Effect.succeed({ cause }),
              // The abort's own reason, as the delivery's aborted request rejects with it.
              AdmissionTimedOut: () =>
                Effect.sync(() => {
                  controller.abort();
                  const reason: unknown = controller.signal.reason;
                  return { cause: reason };
                }),
            }),
          ),
        );
        if (refusal !== null) throw refusal.cause;
      } finally {
        controller.abort();
      }
    },
    async diagnostic(target, request) {
      try {
        const signal = AbortSignal.timeout(4_000);
        await delivery.deliver(
          target,
          "startupDiagnostic",
          new Request(request, { signal }),
          signal,
        );
      } catch {
        /* Best-effort observation never determines a Run or receipt outcome. */
      }
    },
    async deliver(target, callback, request, signal = request.signal) {
      if (target === null) throw new Error("runtime_delivery_unconfigured");
      const selected = select(target);
      const body = await request.text();
      if (decodeDeliveryIdentity(JSON.parse(body)) !== selected.runId)
        throw new Error("runtime_delivery_run_mismatch");
      signal.throwIfAborted();
      return deliverBoundedCallback(
        (input) => selected.callbacks[callback](input),
        // The application learns the callback from the method; the address carries nothing more.
        new Request(applicationCallbackUrl(callback), {
          method: request.method,
          headers: request.headers,
          body,
          signal: request.signal,
        }),
        signal,
      );
    },
  };
  return delivery;
}
