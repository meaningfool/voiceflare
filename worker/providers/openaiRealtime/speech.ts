import type {
  ExecutionObservation,
  ProviderObservationOrder,
} from "../../runtime/interviewFinalizationModel.ts";

/**
 * What the Realtime kit reads from one provider event: a report for Runtime, or the
 * participant's speech starting or stopping, which only the kit reads (its input closure).
 */
export type RealtimeObservation = ExecutionObservation | SpeechObservation;
type SpeechObservation = ProviderObservationOrder &
  Readonly<{ kind: "speech_started" | "speech_stopped"; at: number }>;

/** The report Runtime receives for an observation: speech is the provider's activity to it. */
export function runtimeReport(observation: RealtimeObservation): ExecutionObservation {
  if (!isSpeech(observation)) return observation;
  const { kind: _speech, ...report } = observation;
  return { ...report, kind: "session_activity_observed" };
}

function isSpeech(observation: RealtimeObservation): observation is SpeechObservation {
  return observation.kind === "speech_started" || observation.kind === "speech_stopped";
}
