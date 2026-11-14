import { Context } from "effect";
import type { ProviderCommand } from "./providerCommands.ts";
import type { ProviderOutcome } from "../../runtime/providerOutcomes.ts";

/** Sends a command on the side connection for the duration of one node operation. */
export class RealtimeNativeCommands extends Context.Service<
  RealtimeNativeCommands,
  { send(command: ProviderCommand): ProviderOutcome<void> }
>()("providers/openaiRealtime/RealtimeNativeCommands") {}
