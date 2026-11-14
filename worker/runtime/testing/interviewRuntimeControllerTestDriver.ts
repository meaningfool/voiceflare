import type { RuntimeHostAssembly } from "../runtimeHostAssembly.ts";
import type { RuntimeImplementation } from "../implementationContracts.ts";
import { createRuntimeHostAssembly } from "../../runtimeHostComposition.ts";
import { createRuntimeHostDelivery } from "../../runtimeHostDelivery.ts";
import type { RuntimeDelivery } from "../runtimeDelivery.ts";
import type { ConversationConnectionImplementation } from "../conversationConnection.ts";
import { RuntimeControllerTestDriver } from "../../shared/testing/runtimeControllerDriver.ts";
import { Layer } from "effect";
import { InterviewRuntimeController as ProductionInterviewRuntimeController } from "../interviewRuntimeController.ts";
import {
  RuntimeTestHooks,
  type RuntimeControllerCrashInjectors,
} from "../runtimeControllerServices.ts";
import type { RealtimeProviderDriver } from "../../providers/openaiRealtime/openaiRealtimeDriver.ts";
import {
  realtimeTestDriver,
  type RealtimeDriverScript,
} from "../../providers/openaiRealtime/testing/testDriver.ts";
import type { TestApplicationEnvironment } from "./applicationCallbacks.ts";
import {
  createDurableObjectState,
  type TestInterviewRuntimeDurableObjectContext,
} from "./interviewRuntimeControllerTestHarness.ts";

export type ProviderCreateCallInput = Parameters<
  NonNullable<RealtimeDriverScript["createCall"]>
>[0];
export type ProviderFinalizationOperationInput = Parameters<
  RealtimeProviderDriver["sendFinalizationOperation"]
>[0];
export type ProviderSendCommandInput = Parameters<RealtimeProviderDriver["sendCommand"]>[0];

/** Replaces the selected pair's settings or content preparation for every selection. */
export type SelectedImplementationOverride = Partial<
  Pick<RuntimeImplementation, "prepareSettings" | "prepareContent">
>;

export function overrideSelectedImplementation(
  assembly: RuntimeHostAssembly,
  override: SelectedImplementationOverride,
): RuntimeHostAssembly {
  return {
    ...assembly,
    resolve: (selection) => ({ ...assembly.resolve(selection), ...override }),
  };
}

/**
 * The registry's assembly on the Realtime kit's test driver, scripted by `providerDriver`;
 * unscripted operations are OpenAI's.
 */
export function controlledRealtimeAssembly(
  providerDriver: RealtimeDriverScript = {},
): RuntimeHostAssembly {
  return createRuntimeHostAssembly({ realtimeDriver: realtimeTestDriver(providerDriver) });
}

/**
 * The supplied script drives the Realtime kit's test driver for every Realtime selection,
 * provided as the driver's service through the registry's configuration. An assembly given as a function is built on that
 * controlled assembly; one given as a value is used as it is. The crash injectors reach the
 * controller through its test Layer.
 */
export function createInterviewRuntimeController(
  ctx: TestInterviewRuntimeDurableObjectContext,
  env: TestApplicationEnvironment = {},
  providerDriver: RealtimeDriverScript = {},
  implementationOverride: SelectedImplementationOverride | undefined = undefined,
  crashInjectors: RuntimeControllerCrashInjectors = {},
  connectionImplementation?: ConversationConnectionImplementation,
  assemblyOf: RuntimeHostAssembly | ((controlled: RuntimeHostAssembly) => RuntimeHostAssembly) = (
    controlled,
  ) => controlled,
): ProductionInterviewRuntimeController {
  const assembly =
    typeof assemblyOf === "function"
      ? assemblyOf(controlledRealtimeAssembly(providerDriver))
      : assemblyOf;
  const host = createRuntimeHostDelivery(env);
  const override = env.RUNTIME_COMPLETION_CALLBACK_WORKER;
  // The override receives Transcripts and results as Runtime built them, at their stored URLs.
  const delivery: RuntimeDelivery =
    override === undefined
      ? { ...host, authorize: async () => {} }
      : {
          authorize: async () => {},
          diagnostic: (target, request) => host.diagnostic?.(target, request) ?? Promise.resolve(),
          deliver: (target, callback, request, signal) =>
            callback === "readiness"
              ? host.deliver(target, callback, request, signal)
              : Promise.resolve(override.fetch(request)),
        };
  return new ProductionInterviewRuntimeController(createDurableObjectState(ctx), env, {
    assembly:
      implementationOverride === undefined
        ? assembly
        : overrideSelectedImplementation(assembly, implementationOverride),
    connectionImplementation,
    delivery,
    testLayer: Layer.succeed(RuntimeTestHooks, { crashInjectors }),
  });
}

export function controllerDriver(
  controller: ProductionInterviewRuntimeController,
): RuntimeControllerTestDriver {
  return new RuntimeControllerTestDriver(controller);
}
