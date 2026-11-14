/**
 * The result warnings the Realtime kit attaches with its `result_warning` fact; Runtime publishes
 * no other from it. Speech after Ending closed input may leave the final answer incomplete, a
 * repeated speech start makes it ambiguous, and a side connection that closed unexpectedly or was
 * open when Runtime restarted may have carried events Runtime never received.
 */
export const realtimeResultWarnings = Object.freeze([
  "final_input_may_be_incomplete",
  "ambiguous_final_activity",
  "provider_observation_gap",
] as const);
export type RealtimeResultWarning = (typeof realtimeResultWarnings)[number];
