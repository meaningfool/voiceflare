import type { RuntimeDeliveryTarget } from "../shared/contracts/runtimeDelivery.ts";
import type { ApplicationCallback } from "./applicationCallbacks.ts";

/** The host owns authorization and transport. Runtime owns budgets and receipt validation. */
export type RuntimeDelivery = Readonly<{
  authorize(target: RuntimeDeliveryTarget, runId: string, expiresAt: number): Promise<void>;
  diagnostic?(target: RuntimeDeliveryTarget | null, request: Request): Promise<void>;
  /** Calls the target application's `callback` with the request; its URL is only an envelope. */
  deliver(
    target: RuntimeDeliveryTarget | null,
    callback: ApplicationCallback,
    request: Request,
    signal?: AbortSignal,
  ): Promise<Response>;
}>;
export const unavailableRuntimeDelivery: RuntimeDelivery = {
  authorize: async () => {
    throw new Error("runtime_delivery_unconfigured");
  },
  deliver: async () => {
    throw new Error("runtime_delivery_unconfigured");
  },
};
