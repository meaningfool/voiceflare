import { Duration } from "effect";

/**
 * The time limits of Cascade's finite provider steps (user, 2026-11-01; open to later change).
 * A step that exceeds its limit fails as that provider's failure, with the outcome any failure
 * of the step has. Waiting for the participant is never timed: a listening opportunity and the
 * speech-input stream's silence have no limit.
 */

/** A speech-input or speech-output connection opens within this time of being requested. */
export const providerConnectionTimeLimit = Duration.seconds(10);

/**
 * A model response starts to answer within this time of its request being sent: its first text,
 * tool call or completed output item. The limit covers the request's own connection.
 */
export const modelAnswerStartTimeLimit = Duration.seconds(15);

/** Speech output produces its first audio within this time of receiving its first text. */
export const speechOutputFirstAudioTimeLimit = Duration.seconds(10);
