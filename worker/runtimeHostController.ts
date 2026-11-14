import {
  InterviewRuntimeController as CoreController,
  type InterviewRuntimeControllerHost,
} from "./runtime/interviewRuntimeController.ts";
import { createRuntimeHostDelivery } from "./runtimeHostDelivery.ts";
import { createRuntimeHostAssembly } from "./runtimeHostComposition.ts";
import { localRuntimeConfiguration } from "./runtimeLocalConfiguration.ts";
import type { RealtimeDriverLayer } from "./providers/openaiRealtime/openaiRealtimeDriver.ts";

/**
 * Each Run's pair comes from its accepted selection. Production passes no options; a test
 * may replace the assembly, configure the local assembly with the Realtime kit's test driver
 * (`realtimeTestDriver`), provided as the driver's service, or supply a test Layer with crash
 * hooks.
 */
export type RuntimeHostControllerOptions = Omit<InterviewRuntimeControllerHost, "delivery"> &
  Readonly<{ realtimeDriver: RealtimeDriverLayer }>;

export class InterviewRuntimeController extends CoreController {
  constructor(
    ctx: DurableObjectState,
    env: ConstructorParameters<typeof CoreController>[1],
    options: Partial<RuntimeHostControllerOptions> = {},
  ) {
    const { realtimeDriver, ...host } = options;
    super(ctx, env, {
      ...host,
      assembly:
        host.assembly ??
        createRuntimeHostAssembly(
          realtimeDriver === undefined
            ? localRuntimeConfiguration
            : { ...localRuntimeConfiguration, realtimeDriver },
        ),
      delivery: createRuntimeHostDelivery(env),
    });
  }
}
