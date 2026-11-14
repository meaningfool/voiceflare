import { Effect, Layer } from "effect";
import { CascadeLanguageModel, CascadeSpeechInput, CascadeSpeechOutput } from "./adapters.ts";
import { CascadeMedia, CascadeMediaSession } from "./mediaSession.ts";
import { CascadeProviderSettings, cascadeDefaultProviderSettings } from "./settings.ts";
import type { CascadeProviders } from "./adapters.ts";
import type { ExecutionBridge } from "../../runtime/runtimeHostAssembly.ts";

/** The bridge runs only fully assembled Cascade flows: every service must be provided. */
function checkCascadeAssembly(bridge: ExecutionBridge, providers: CascadeProviders): void {
  const flow = Effect.gen(function* () {
    yield* CascadeSpeechInput;
    yield* CascadeLanguageModel;
    yield* CascadeSpeechOutput;
    yield* CascadeMedia;
  });
  const media = Layer.succeed(CascadeMedia, new CascadeMediaSession().media);
  const settings = Layer.succeed(CascadeProviderSettings, cascadeDefaultProviderSettings);
  const configured = providers.pipe(Layer.provide(settings));
  bridge.supervise(flow.pipe(Effect.provide(Layer.mergeAll(configured, media))));
  // @ts-expect-error Without their settings the providers still require them.
  bridge.supervise(flow.pipe(Effect.provide(Layer.mergeAll(providers, media))));
  // @ts-expect-error Without the media session the flow still requires it.
  bridge.supervise(flow.pipe(Effect.provide(configured)));
  // @ts-expect-error Without the providers the flow still requires them.
  bridge.supervise(flow.pipe(Effect.provide(media)));
}
void checkCascadeAssembly;
