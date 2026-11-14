import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import type { ConversationCallbackJson } from "../../runtime/conversationContracts.ts";

/**
 * What the Realtime kit keeps in Runtime's durable storage for executions, read back after a
 * Runtime restart:
 * - `inputBuffered`: the participant's speech was buffered and not yet committed, which a
 *   closing or Ending's input closure still settles;
 * - `sideConnectionOpen`: the side connection was open, so events it carried during the
 *   restart may be missing.
 */
export type RealtimeExecutionState = Readonly<{
  inputBuffered: boolean;
  sideConnectionOpen: boolean;
}>;

const decodeStoredState = boundary({
  schema: z.strictObject({ inputBuffered: z.boolean(), sideConnectionOpen: z.boolean() }),
  convert: (value): RealtimeExecutionState => value,
});

/** The kit's state as Runtime kept it; none kept, or one the kit cannot read, holds no speech. */
export function decodeRealtimeExecutionState(
  stored: ConversationCallbackJson | null | undefined,
): RealtimeExecutionState {
  if (stored === null || stored === undefined)
    return { inputBuffered: false, sideConnectionOpen: false };
  try {
    return decodeStoredState(stored);
  } catch {
    // An unreadable record retains nothing: the closing then commits only what it observes.
    return { inputBuffered: false, sideConnectionOpen: false };
  }
}
