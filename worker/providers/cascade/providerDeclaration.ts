import type { Layer } from "effect";
import type { ReasoningEffort } from "../../runtime/nativeContracts.ts";

/** What a real Cascade adapter is built with: its credential's value and the network transport. */
export type CascadeAdapterOptions = Readonly<{
  apiKey: string;
  /** The network transport; the platform's `fetch` unless a caller injects one. */
  transport: typeof fetch;
}>;

/**
 * What one Cascade provider declares next to its adapter, which Cascade's settings and its
 * provider assembly compose: the name a settings group's `provider` gives it, today's values of
 * its settings, the credential it needs, named as Runtime reads it, the provider its usage
 * entries name, and its adapter, built from that credential and the Run's settings for it. A
 * language model that accepts only some reasoning efforts names them; a Start choosing it with
 * another is refused. Its settings schemas sit beside it, since each group's schema names every
 * provider's own.
 */
export type CascadeProviderDeclaration<
  Settings extends Readonly<{ provider: string }>,
  Service,
> = Readonly<{
  provider: Settings["provider"];
  defaults: Settings;
  credentials: readonly [string];
  usage: Readonly<{ provider: string }>;
  reasoningEfforts?: readonly ReasoningEffort[];
  adapter(options: CascadeAdapterOptions, settings: Settings): Layer.Layer<Service>;
}>;
