import { z } from "zod";

/**
 * Runtime's own result warnings: the fixed list Runtime adds to a Run's result on every
 * execution. A warning that only one execution can produce is that execution's, declared next to
 * its code and shown in Runtime's catalog for each combination, as its usage is.
 */
export const runtimeWarnings = Object.freeze([
  "ambiguous_final_activity",
  "final_input_may_be_incomplete",
  "participant_transcription_failed",
  "drain_timed_out",
  "session_closed_with_pending_input",
  "agent_output_not_fully_delivered",
  "post_end_input_leaked",
  "post_end_output_leaked",
  "session_release_failed",
  "session_release_timed_out",
  "session_release_uncertain",
  "session_close_unconfirmed",
  "runtime_failed_during_finalization",
  "closing_response_failed",
  "closing_cutoff_exhausted",
  "closing_recovery_uncertain",
  "closing_interrupted",
] as const);
export type RuntimeWarning = (typeof runtimeWarnings)[number];

/**
 * A result warning's name: one of Runtime's own or one an execution declares. Readers check only
 * its shape, a lower-case snake_case name, and keep no list of their own; Runtime publishes only
 * its own warnings and those the Run's combination declares.
 */
export const resultWarningSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u);
export type ResultWarning = z.output<typeof resultWarningSchema>;
